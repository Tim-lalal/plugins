/* --------------------------------------------------------------------------------------------
 * Copyright (c) Jan Dolejsi. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import {
    window, ExtensionContext, Uri, ViewColumn, WebviewPanel, commands, Disposable, workspace, TextEditorRevealType, TextEditor, Range, Webview
} from 'vscode';
import * as path from 'path';

import { getWebViewHtml, createPddlExtensionContext } from '../utils';
import { State } from './State';
import { PlanReportGenerator } from '../planning/PlanReportGenerator';
import { StateToPlan } from './StateToPlan';
import { StateResolver } from './StateResolver';
import { ProblemInfo } from 'pddl-workspace';
import { DomainInfo } from 'pddl-workspace';

import FormData = require('form-data');
import fetch, {RequestInit} from "node-fetch";
import btoa = require('btoa');

export class SearchDebuggerView {
    private webViewPanel: WebviewPanel | undefined;
    private subscriptions: Disposable[] = [];
    private search: StateResolver | undefined;
    private stateChangedWhileViewHidden = false;
    private stateLogFile: Uri | undefined;
    private stateLogEditor: TextEditor | undefined;
    private stateLogLineCache = new Map<string, number>();
    private domain: DomainInfo | undefined;
    private problem: ProblemInfo | undefined;

    // cached values
    private debuggerState: boolean | undefined;
    private port: number | undefined;

    constructor(private context: ExtensionContext) {
    }

    isVisible(): boolean {
        return this.webViewPanel !== undefined && this.webViewPanel.visible;
    }

    observe(search: StateResolver): void {
        this.search = search;
        // first unsubscribe from previous search
        this.subscriptions.forEach(subscription => subscription.dispose());
        this.subscriptions = [];

        this.subscriptions.push(search.onStateAdded(newState => this.addState(newState)));
        this.subscriptions.push(search.onStateUpdated(newState => this.update(newState)));
        this.subscriptions.push(search.onBetterState(betterState => this.displayBetterState(betterState)));
        this.subscriptions.push(search.onPlanFound(planStates => this.displayPlan(planStates)));
    }

    setDomainAndProblem(domain: DomainInfo, problem: ProblemInfo): void {
        this.domain = domain;
        this.problem = problem;
    }

    async showDebugView(): Promise<void> {
        if (this.webViewPanel !== undefined) {
            this.webViewPanel.reveal();
        }
        else {
            await this.createDebugView(false);
        }
    }

    async createDebugView(showOnTop: boolean): Promise<void> {
        const iconUri = this.context.asAbsolutePath('images/icon.png');

        this.webViewPanel = window.createWebviewPanel(
            "pddl.SearchDebugger",
            "Search Debugger",
            {
                viewColumn: ViewColumn.Active,
                preserveFocus: !showOnTop
            },
            {
                retainContextWhenHidden: true,
                enableFindWidget: true,
                enableCommandUris: true,
                enableScripts: true,
                localResourceRoots: [Uri.file(this.context.asAbsolutePath("views"))]
            }
        );

        const html = await this.getHtml(this.webViewPanel.webview);
        this.webViewPanel.webview.html = html;
        this.webViewPanel.iconPath = Uri.file(iconUri);

        this.webViewPanel.onDidDispose(() => this.webViewPanel = undefined, undefined, this.context.subscriptions);
        this.webViewPanel.webview.onDidReceiveMessage(message => this.handleMessage(message), undefined, this.context.subscriptions);
        this.webViewPanel.onDidChangeViewState(event => this.changedViewState(event.webviewPanel));

        this.context.subscriptions.push(this.webViewPanel); // todo: this may not be necessary
    }

    changedViewState(webViewPanel: WebviewPanel): void {
        if (webViewPanel.visible) {
            this.showDebuggerState();
            if (this.stateChangedWhileViewHidden) {
                // re-send all states
                this.showAllStates();
            }

            // reset the state
            this.stateChangedWhileViewHidden = false;
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async handleMessage(message: any): Promise<void> {
        console.log(`Message received from the webview: ${message.command}`);

        switch (message.command) {
            case 'onload':
                this.showDebuggerState();
                break;
            case 'stateSelected':
                try {
                    this.showStatePlan(message.stateId);
                    this.scrollStateLog(message.stateId);
                    this.sendRequestToPlanimationApi(message.stateInfo);
                }
                catch (ex) {
                    window.showErrorMessage("Error while displaying state-plan: " + ex);
                }
                break;
            case 'startDebugger':
                commands.executeCommand("pddl.searchDebugger.start");
                this.stateLogLineCache.clear();
                break;
            case 'stopDebugger':
                commands.executeCommand("pddl.searchDebugger.stop");
                break;
            case 'reset':
                commands.executeCommand("pddl.searchDebugger.reset");
                break;
            case 'toggleStateLog':
                this.toggleStateLog();
                break;
            default:
                console.warn('Unexpected command: ' + message.command);
        }
    }

    CONTENT_FOLDER = path.join('views', 'searchview');

    async getHtml(webview: Webview): Promise<string> {
        const googleCharts = Uri.parse("https://www.gstatic.com/charts/");
        return getWebViewHtml(createPddlExtensionContext(this.context), {
            relativePath: this.CONTENT_FOLDER, htmlFileName: 'search.html',
            externalImages: [Uri.parse('data:')],
            externalScripts: [googleCharts],
            externalStyles: [googleCharts]
        }, webview);
    }

    setDebuggerState(on: boolean, port: number): void {
        this.debuggerState = on;
        this.port = port;
        this.showDebuggerState();
    }

    private showDebuggerState(): void {
        this.postMessage({
            command: "debuggerState", state: {
                running: this.debuggerState ? 'on' : 'off',
                port: this.port
            }
        });
    }

    addState(newState: State): void {
        new Promise(() => this.postMessage({ command: 'stateAdded', state: newState }))
            .catch(reason => console.log(reason));
    }

    update(state: State): void {
        new Promise(() => this.postMessage({ command: 'stateUpdated', state: state }))
            .catch(reason => console.log(reason));
    }

    showAllStates(): void {
        const allStates = this.search?.getStates() ?? [];
        new Promise(() => this.postMessage({ command: 'showAllStates', state: allStates }))
            .catch(reason => console.log(reason));
    }

    sendRequestToPlanimationApi(subGoal: string): void{
        const re = /(.*\(:goal\s*\(and\s*)((.|\n)*)(.*\)\s*\)\s*\))/;
        console.log(subGoal);
        const domain = `(define (domain grid-visit-all)
        (:requirements :typing)
        (:types        place - object)
        (:predicates (connected ?x ?y - place)
                 (at ?x - place)
                 (visited ?x - place)
        )
            
        (:action move
        :parameters (?curpos ?nextpos - place)
        :precondition (and (at ?curpos) (connected ?curpos ?nextpos))
        :effect (and (at ?nextpos) (not (at ?curpos)) (visited ?nextpos))
        )
        
        )`;
        const problem = `(define (problem grid-12)
        (:domain grid-visit-all)
        (:objects 
        
        loc1_1 loc1_2 loc2_1 loc2_2 - place 
        
                
        )
        (:init
            (at loc1_1)
            (visited loc1_1)
            
        (connected loc1_1 loc2_1)
        (connected loc2_1 loc1_1)
        (connected loc1_2 loc1_1)
        (connected loc1_2 loc2_2)
        (connected loc2_2 loc1_2)
        (connected loc1_1 loc1_2)
        (connected loc2_1 loc2_2)
        (connected loc2_2 loc2_1)
         
        )
        (:goal
        (and 
            (visited loc1_1)
            (visited loc1_2)
            (visited loc2_1)
            (visited loc2_2)
        )
        )
        )`;
        const ap = `(define (animation Visitall)

        ; Defines the Animation profile for Visitall
        ; Written By Nir Lipovetzky
        
        ; Specifies that the robot is at a position
        ; We place the robot's x and y coordinates at this point
          (:predicate at
                       :parameters (?x)
                       :custom robot
                       :effect(
                       (equal (robot x) (?x x))
                       (equal (robot y) (?x y))
                       (equal (?x color) #FAA2B5)
                       )
          )
        
        ; Specifies that an object is a place (node)
        ; Here we just distribute the objects in a grid formation on screen
        ; This distribute function automatically aligns objects on-screen based on any
        ; numbers detected in the objects' name. Hence we require that nodes are named according
        ; to the convention nodex0-y0, node2-1, etc, or similar. Regex is \d+ for row and col.
          (:predicate connected
                       :parameters (?from ?to)
                       :effect(
                       (assign (?from x y) (function distribute_grid_around_point (objects ?from)))
                       )
          )
        
        ; Specifies that a lock is locked. We just change its colour to pink
          (:predicate visited
                       :parameters (?x)
                       :effect(
                       (equal (?x color) #FAA2B5)
                       )
          )
        
        
        ; Custom object representing the robot
        ; Moves around according to at-robot predicate
          (:visual robot
                    :type custom
                    :objects robot
                    :properties(
                      (prefabImage img-robot)
                      (showName FALSE)
                      (x Null)
                      (y Null)
                      (color #FAA2B5)
                      (width 40)
                      (height 40)
                      (depth 2)
                    )
          )
        
        
        ; Default node type. 
          (:visual loc
                    :type default
                    :object (%loc)
                    :properties(
                      (prefabImage img-square)
                      (showName FALSE)
                      (x Null)
                      (y Null)
                      (color BLUE)
                      (width 80)
                      (height 80)
                      (depth 1)
                  )
          )
          
         (:image  (img-square iVBORw0KGgoAAAANSUhEUgAAAXEAAAFxCAIAAAAK5Q/zAAABN2lDQ1BBZG9iZSBSR0IgKDE5OTgpAAAokZWPv0rDUBSHvxtFxaFWCOLgcCdRUGzVwYxJW4ogWKtDkq1JQ5ViEm6uf/oQjm4dXNx9AidHwUHxCXwDxamDQ4QMBYvf9J3fORzOAaNi152GUYbzWKt205Gu58vZF2aYAoBOmKV2q3UAECdxxBjf7wiA10277jTG+38yH6ZKAyNguxtlIYgK0L/SqQYxBMygn2oQD4CpTto1EE9AqZf7G1AKcv8ASsr1fBBfgNlzPR+MOcAMcl8BTB1da4Bakg7UWe9Uy6plWdLuJkEkjweZjs4zuR+HiUoT1dFRF8jvA2AxH2w3HblWtay99X/+PRHX82Vun0cIQCw9F1lBeKEuf1UYO5PrYsdwGQ7vYXpUZLs3cLcBC7dFtlqF8hY8Dn8AwMZP/fNTP8gAAAAJcEhZcwAACxMAAAsTAQCanBgAAAXxaVRYdFhNTDpjb20uYWRvYmUueG1wAAAAAAA8P3hwYWNrZXQgYmVnaW49Iu+7vyIgaWQ9Ilc1TTBNcENlaGlIenJlU3pOVGN6a2M5ZCI/PiA8eDp4bXBtZXRhIHhtbG5zOng9ImFkb2JlOm5zOm1ldGEvIiB4OnhtcHRrPSJBZG9iZSBYTVAgQ29yZSA1LjYtYzE0MCA3OS4xNjA0NTEsIDIwMTcvMDUvMDYtMDE6MDg6MjEgICAgICAgICI+IDxyZGY6UkRGIHhtbG5zOnJkZj0iaHR0cDovL3d3dy53My5vcmcvMTk5OS8wMi8yMi1yZGYtc3ludGF4LW5zIyI+IDxyZGY6RGVzY3JpcHRpb24gcmRmOmFib3V0PSIiIHhtbG5zOnhtcD0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wLyIgeG1sbnM6ZGM9Imh0dHA6Ly9wdXJsLm9yZy9kYy9lbGVtZW50cy8xLjEvIiB4bWxuczpwaG90b3Nob3A9Imh0dHA6Ly9ucy5hZG9iZS5jb20vcGhvdG9zaG9wLzEuMC8iIHhtbG5zOnhtcE1NPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvbW0vIiB4bWxuczpzdEV2dD0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wL3NUeXBlL1Jlc291cmNlRXZlbnQjIiB4bXA6Q3JlYXRvclRvb2w9IkFkb2JlIFBob3Rvc2hvcCBDQyAyMDE4IChNYWNpbnRvc2gpIiB4bXA6Q3JlYXRlRGF0ZT0iMjAxOC0wOC0xMlQxMjoxOTo1MSsxMDowMCIgeG1wOk1vZGlmeURhdGU9IjIwMTgtMDgtMTVUMjA6MzY6NDgrMTA6MDAiIHhtcDpNZXRhZGF0YURhdGU9IjIwMTgtMDgtMTVUMjA6MzY6NDgrMTA6MDAiIGRjOmZvcm1hdD0iaW1hZ2UvcG5nIiBwaG90b3Nob3A6Q29sb3JNb2RlPSIzIiBwaG90b3Nob3A6SUNDUHJvZmlsZT0iQWRvYmUgUkdCICgxOTk4KSIgeG1wTU06SW5zdGFuY2VJRD0ieG1wLmlpZDo5MGRmODdjNy1lN2YxLTQ5NmMtYjE1Yy1kYjIzNDAxNDQxZWMiIHhtcE1NOkRvY3VtZW50SUQ9InhtcC5kaWQ6ZmJlOWI4NTQtNDJlYy00ODE3LTgxNWQtMzY0YjAxMTRiODQ3IiB4bXBNTTpPcmlnaW5hbERvY3VtZW50SUQ9InhtcC5kaWQ6ZmJlOWI4NTQtNDJlYy00ODE3LTgxNWQtMzY0YjAxMTRiODQ3Ij4gPHhtcE1NOkhpc3Rvcnk+IDxyZGY6U2VxPiA8cmRmOmxpIHN0RXZ0OmFjdGlvbj0iY3JlYXRlZCIgc3RFdnQ6aW5zdGFuY2VJRD0ieG1wLmlpZDpmYmU5Yjg1NC00MmVjLTQ4MTctODE1ZC0zNjRiMDExNGI4NDciIHN0RXZ0OndoZW49IjIwMTgtMDgtMTJUMTI6MTk6NTErMTA6MDAiIHN0RXZ0OnNvZnR3YXJlQWdlbnQ9IkFkb2JlIFBob3Rvc2hvcCBDQyAyMDE4IChNYWNpbnRvc2gpIi8+IDxyZGY6bGkgc3RFdnQ6YWN0aW9uPSJzYXZlZCIgc3RFdnQ6aW5zdGFuY2VJRD0ieG1wLmlpZDo5MGRmODdjNy1lN2YxLTQ5NmMtYjE1Yy1kYjIzNDAxNDQxZWMiIHN0RXZ0OndoZW49IjIwMTgtMDgtMTVUMjA6MzY6NDgrMTA6MDAiIHN0RXZ0OnNvZnR3YXJlQWdlbnQ9IkFkb2JlIFBob3Rvc2hvcCBDQyAyMDE4IChNYWNpbnRvc2gpIiBzdEV2dDpjaGFuZ2VkPSIvIi8+IDwvcmRmOlNlcT4gPC94bXBNTTpIaXN0b3J5PiA8L3JkZjpEZXNjcmlwdGlvbj4gPC9yZGY6UkRGPiA8L3g6eG1wbWV0YT4gPD94cGFja2V0IGVuZD0iciI/Ppcsu5QAAASfSURBVHic7dTBCQAgEMAwdf+dzyUKgiQT9NU9Mwsgcl4HAF/xFKDkKUDJU4CSpwAlTwFKngKUPAUoeQpQ8hSg5ClAyVOAkqcAJU8BSp4ClDwFKHkKUPIUoOQpQMlTgJKnACVPAUqeApQ8BSh5ClDyFKDkKUDJU4CSpwAlTwFKngKUPAUoeQpQ8hSg5ClAyVOAkqcAJU8BSp4ClDwFKHkKUPIUoOQpQMlTgJKnACVPAUqeApQ8BSh5ClDyFKDkKUDJU4CSpwAlTwFKngKUPAUoeQpQ8hSg5ClAyVOAkqcAJU8BSp4ClDwFKHkKUPIUoOQpQMlTgJKnACVPAUqeApQ8BSh5ClDyFKDkKUDJU4CSpwAlTwFKngKUPAUoeQpQ8hSg5ClAyVOAkqcAJU8BSp4ClDwFKHkKUPIUoOQpQMlTgJKnACVPAUqeApQ8BSh5ClDyFKDkKUDJU4CSpwAlTwFKngKUPAUoeQpQ8hSg5ClAyVOAkqcAJU8BSp4ClDwFKHkKUPIUoOQpQMlTgJKnACVPAUqeApQ8BSh5ClDyFKDkKUDJU4CSpwAlTwFKngKUPAUoeQpQ8hSg5ClAyVOAkqcAJU8BSp4ClDwFKHkKUPIUoOQpQMlTgJKnACVPAUqeApQ8BSh5ClDyFKDkKUDJU4CSpwAlTwFKngKUPAUoeQpQ8hSg5ClAyVOAkqcAJU8BSp4ClDwFKHkKUPIUoOQpQMlTgJKnACVPAUqeApQ8BSh5ClDyFKDkKUDJU4CSpwAlTwFKngKUPAUoeQpQ8hSg5ClAyVOAkqcAJU8BSp4ClDwFKHkKUPIUoOQpQMlTgJKnACVPAUqeApQ8BSh5ClDyFKDkKUDJU4CSpwAlTwFKngKUPAUoeQpQ8hSg5ClAyVOAkqcAJU8BSp4ClDwFKHkKUPIUoOQpQMlTgJKnACVPAUqeApQ8BSh5ClDyFKDkKUDJU4CSpwAlTwFKngKUPAUoeQpQ8hSg5ClAyVOAkqcAJU8BSp4ClDwFKHkKUPIUoOQpQMlTgJKnACVPAUqeApQ8BSh5ClDyFKDkKUDJU4CSpwAlTwFKngKUPAUoeQpQ8hSg5ClAyVOAkqcAJU8BSp4ClDwFKHkKUPIUoOQpQMlTgJKnACVPAUqeApQ8BSh5ClDyFKDkKUDJU4CSpwAlTwFKngKUPAUoeQpQ8hSg5ClAyVOAkqcAJU8BSp4ClDwFKHkKUPIUoOQpQMlTgJKnACVPAUqeApQ8BSh5ClDyFKDkKUDJU4CSpwAlTwFKngKUPAUoeQpQ8hSg5ClAyVOAkqcAJU8BSp4ClDwFKHkKUPIUoOQpQMlTgJKnACVPAUqeApQ8BSh5ClDyFKDkKUDJU4CSpwAlTwFKngKUPAUoeQpQ8hSg5ClAyVOAkqcAJU8BSp4ClDwFKHkKUPIUoOQpQMlTgJKnACVPAUqeApQ8BSh5ClDyFKDkKUDJU4CSpwAlTwFKngKUPAUoeQpQ8hSg5ClAyVOAkqcAJU8BSp4ClDwFKHkKUPIUoOQpQMlTgJKnACVPAUqeApQ8BSh5ClDyFKDkKUDJU4CSpwAlTwFKngKUPAUoXWSoBd9t2wfhAAAAAElFTkSuQmCC)
                  (img-robot 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)
                  (line  iVBORw0KGgoAAAANSUhEUgAAA84AAAAFCAIAAAAbsCLlAAAACXBIWXMAAAsTAAALEwEAmpwYAAAGwGlUWHRYTUw6Y29tLmFkb2JlLnhtcAAAAAAAPD94cGFja2V0IGJlZ2luPSLvu78iIGlkPSJXNU0wTXBDZWhpSHpyZVN6TlRjemtjOWQiPz4gPHg6eG1wbWV0YSB4bWxuczp4PSJhZG9iZTpuczptZXRhLyIgeDp4bXB0az0iQWRvYmUgWE1QIENvcmUgNS42LWMxNDAgNzkuMTYwNDUxLCAyMDE3LzA1LzA2LTAxOjA4OjIxICAgICAgICAiPiA8cmRmOlJERiB4bWxuczpyZGY9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkvMDIvMjItcmRmLXN5bnRheC1ucyMiPiA8cmRmOkRlc2NyaXB0aW9uIHJkZjphYm91dD0iIiB4bWxuczp4bXBNTT0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wL21tLyIgeG1sbnM6c3RSZWY9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC9zVHlwZS9SZXNvdXJjZVJlZiMiIHhtbG5zOnN0RXZ0PSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvc1R5cGUvUmVzb3VyY2VFdmVudCMiIHhtbG5zOnhtcD0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wLyIgeG1sbnM6ZGM9Imh0dHA6Ly9wdXJsLm9yZy9kYy9lbGVtZW50cy8xLjEvIiB4bWxuczpwaG90b3Nob3A9Imh0dHA6Ly9ucy5hZG9iZS5jb20vcGhvdG9zaG9wLzEuMC8iIHhtcE1NOk9yaWdpbmFsRG9jdW1lbnRJRD0ieG1wLmRpZDpBQTA1RUE1QjMzMjA2ODExODIyQUM4NjE0MERCRDI1NiIgeG1wTU06RG9jdW1lbnRJRD0ieG1wLmRpZDpFNUU1MTE2OEZBQTExMUUzODBFQ0E4Mjg2RkNEODNGOSIgeG1wTU06SW5zdGFuY2VJRD0ieG1wLmlpZDo2MGJhZmVjNy1iMDY3LTRlYWMtYTdhYS0yOWQyNGFkYmEyZTYiIHhtcDpDcmVhdG9yVG9vbD0iQWRvYmUgUGhvdG9zaG9wIENTNiAoTWFjaW50b3NoKSIgeG1wOkNyZWF0ZURhdGU9IjIwMTgtMDgtMTJUMTI6MjA6MzMrMTA6MDAiIHhtcDpNb2RpZnlEYXRlPSIyMDE4LTA4LTE1VDIwOjM2OjQyKzEwOjAwIiB4bXA6TWV0YWRhdGFEYXRlPSIyMDE4LTA4LTE1VDIwOjM2OjQyKzEwOjAwIiBkYzpmb3JtYXQ9ImltYWdlL3BuZyIgcGhvdG9zaG9wOkNvbG9yTW9kZT0iMyIgcGhvdG9zaG9wOklDQ1Byb2ZpbGU9InNSR0IgSUVDNjE5NjYtMi4xIj4gPHhtcE1NOkRlcml2ZWRGcm9tIHN0UmVmOmluc3RhbmNlSUQ9InhtcC5paWQ6RkI3RjExNzQwNzIwNjgxMTgzRDE5QTYzMUY5NDkyQUEiIHN0UmVmOmRvY3VtZW50SUQ9InhtcC5kaWQ6QUEwNUVBNUIzMzIwNjgxMTgyMkFDODYxNDBEQkQyNTYiLz4gPHhtcE1NOkhpc3Rvcnk+IDxyZGY6U2VxPiA8cmRmOmxpIHN0RXZ0OmFjdGlvbj0ic2F2ZWQiIHN0RXZ0Omluc3RhbmNlSUQ9InhtcC5paWQ6YjhhMTA1MjQtNGViMS00NGEwLWI4ZDgtNGQwNWY2Y2U2NjdhIiBzdEV2dDp3aGVuPSIyMDE4LTA4LTEyVDEyOjIxOjU0KzEwOjAwIiBzdEV2dDpzb2Z0d2FyZUFnZW50PSJBZG9iZSBQaG90b3Nob3AgQ0MgMjAxOCAoTWFjaW50b3NoKSIgc3RFdnQ6Y2hhbmdlZD0iLyIvPiA8cmRmOmxpIHN0RXZ0OmFjdGlvbj0ic2F2ZWQiIHN0RXZ0Omluc3RhbmNlSUQ9InhtcC5paWQ6NjBiYWZlYzctYjA2Ny00ZWFjLWE3YWEtMjlkMjRhZGJhMmU2IiBzdEV2dDp3aGVuPSIyMDE4LTA4LTE1VDIwOjM2OjQyKzEwOjAwIiBzdEV2dDpzb2Z0d2FyZUFnZW50PSJBZG9iZSBQaG90b3Nob3AgQ0MgMjAxOCAoTWFjaW50b3NoKSIgc3RFdnQ6Y2hhbmdlZD0iLyIvPiA8L3JkZjpTZXE+IDwveG1wTU06SGlzdG9yeT4gPC9yZGY6RGVzY3JpcHRpb24+IDwvcmRmOlJERj4gPC94OnhtcG1ldGE+IDw/eHBhY2tldCBlbmQ9InIiPz5XefbLAAAAOElEQVRoge3WwQ0AIBDDMGD/ncsSVCche4I8s5MsAADgtTMdAAAAf7LaAABQYbUBAKDCagMAQMUF9FADB/07X9MAAAAASUVORK5CYII=)
         )
        )`;
        const newProblem = problem.replace(re, "$1" + subGoal + "$4");
        
        var fd = new FormData();
        fd.append("domain", domain);
        fd.append("problem", newProblem);
        fd.append("animation", ap);
        fd.append("fileType", "spng");
        // var xhr = new XMLHttpRequest();
        // xhr.responseType = "arraybuffer";
        // xhr.open("POST","http://127.0.0.1:8000/upload/(?P<filename>[^/]+)$");
        // xhr.onreadystatechange = function(){
        //     if (xhr.readyState == XMLHttpRequest.DONE && xhr.status == 200){
        //         var i = document.createElement("img");
        //         i.setAttribute('src', 'data:image/png;base64,' + btoa(String.fromCharCode.apply(null, new Uint8Array(xhr.response))));
        //         document.getElementById("planimation").innerHTML = i;
        //     } else {
        //         postMessage({command: xhr.status + " " + xhr.readyState});
        //     }
        // }
        // xhr.send(fd);
        const requestOptions: RequestInit = {
            method: "POST",
            body: fd,
        };
        
        fetch("http://127.0.0.1:8000/upload/(?P<filename>[^/]+)$", requestOptions)
            .then(response => {
                response.arrayBuffer().then( buffer =>{
                    var src = 'data:image/png;base64,' + this.arrayBufferToBase64(buffer) ;
                    new Promise(() => this.postMessage({ command: 'getPNGOfNode', state: src }))
                        .catch(reason => console.log(reason));
                    console.log(buffer.byteLength);
                    console.log({ command: 'getPNGOfNode', state: src });
                });
                // console.log(this.arrayBufferToBase64(response.arrayBuffer()));
                
                // console.log(src);
                
            })
            .catch(error => console.log('error' + error));
        // const req = request({
        //     host: '127.0.0.1',
        //     port: '8000',
        //     path: "/upload/(?P<filename>[^/]+)$",
        //     method: 'POST',
        //     headers: fd.getHeaders()
        // },
        // response =>{
        //     console.log(response);
        // }
        // );
        // fd.pipe(req);


        console.log(newProblem);
        
    }

    private arrayBufferToBase64(buffer: any) {
        let binary = "";
        const bytes = [].slice.call(new Uint8Array(buffer));
        bytes.forEach((b:any) => binary += String.fromCharCode(b));
        return btoa(binary);
    }

    displayBetterState(state: State): void {
        try {
            this.showStatePlan(state.id);
        } catch (ex) {
            window.showErrorMessage(ex.message ?? ex);
        }
    }

    displayPlan(planStates: State[]): void {
        new Promise(() => this.postMessage({ command: 'showPlan', state: planStates }))
            .catch(reason => console.log(reason));
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private postMessage(message: { command: string; state: any }): void {
        if (this.webViewPanel !== undefined) {
            this.webViewPanel.webview.postMessage(message);

            if (!this.webViewPanel.visible) {
                this.stateChangedWhileViewHidden = true;
            }
        }
    }

    async showStatePlan(stateId: number): Promise<void> {
        if (this.search === undefined) { return void 0; }
        if (stateId === null) { return void 0; }
        const state = this.search.getState(stateId);
        if (!state) { return; }
        const statePlan = new StateToPlan(this.domain, this.problem).convert(state);
        const planHtml = await new PlanReportGenerator(this.context,
            {
                displayWidth: 200, selfContained: false, disableLinePlots: true, disableSwimLaneView: false, disableHamburgerMenu: true,
                resourceUriConverter: this.webViewPanel.webview
            })
            .generateHtml([statePlan]);
        this.postMessage({ command: 'showStatePlan', state: planHtml });
    }

    clear(): void {
        this.postMessage({ command: 'clear', state: 'n/a' });
        this.stateLogLineCache.clear();
        this.domain = undefined;
        this.problem = undefined;
    }

    async toggleStateLog(): Promise<void> {
        if (this.stateLogFile !== undefined) {
            this.postMessage({ command: 'stateLog', state: null });
        }
        else {
            const selectedUri = await window.showOpenDialog({ canSelectMany: false, defaultUri: this.stateLogFile, canSelectFolders: false });
            if (!selectedUri) { return; }
            this.stateLogFile = selectedUri[0];
            this.stateLogEditor = await window.showTextDocument(await workspace.openTextDocument(this.stateLogFile), { preserveFocus: true, viewColumn: ViewColumn.Beside });
            this.postMessage({ command: 'stateLog', state: this.stateLogFile.fsPath });
        }
    }

    async scrollStateLog(stateId: number): Promise<void> {
        if (!this.stateLogFile || !this.stateLogEditor || !this.search) { return; }
        const state = this.search.getState(stateId);
        if (!state) { return; }

        if (this.stateLogEditor.document.isClosed) {
            this.stateLogEditor = await window.showTextDocument(this.stateLogEditor.document, ViewColumn.Beside);
        }

        if (this.stateLogLineCache.has(state.origId)) {
            const cachedLineId = this.stateLogLineCache.get(state.origId);
            if (cachedLineId) {
                this.stateLogEditor.revealRange(new Range(cachedLineId, 0, cachedLineId + 1, 0), TextEditorRevealType.AtTop);
            }
            return;
        }

        const pattern = workspace.getConfiguration("pddlSearchDebugger").get<string>("stateLogPattern", "");

        for (let lineIdx = 0; lineIdx < this.stateLogEditor.document.lineCount; lineIdx++) {
            const logLine = this.stateLogEditor.document.lineAt(lineIdx);
            const patternMatch = logLine.text.match(new RegExp(pattern));
            if (patternMatch && patternMatch[1] === state.origId) {
                this.stateLogEditor.revealRange(logLine.range, TextEditorRevealType.AtTop);
                this.stateLogLineCache.set(state.origId, lineIdx);
                break;
            }
        }
    }
}