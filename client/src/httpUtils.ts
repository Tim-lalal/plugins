/* --------------------------------------------------------------------------------------------
 * Copyright (c) Jan Dolejsi. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import * as request from 'request';

export function getJson(url: string): Promise<any> {
    return new Promise<any>((resolve, reject) => {
        request.get(url, { json: true }, (error: any, httpResponse: request.Response, body: any) => {
            if (error) {
                reject(error);
            }
            else {
                if (httpResponse && httpResponse.statusCode !== 200) {
                    reject("HTTP status code " + httpResponse.statusCode);
                }
                else {
                    resolve(body);
                }
            }
        });
    });
}

export function getText(url: string): string | PromiseLike<string> {
    return new Promise<string>((resolve, reject) => {
        request.get(url, (error: any, httpResponse: request.Response, body: any) => {
            if (error) {
                reject(error);
            }
            else {
                if (httpResponse && httpResponse.statusCode !== 200) {
                    reject("HTTP status code " + httpResponse.statusCode);
                }
                else {
                    resolve(body);
                }
            }
        });
    });
}

export function postJson(url: string, content: any): Promise<any> {
    return new Promise<string>((resolve, reject) => {
        request.post(url, { body: content, json: true }, (error: any, httpResponse: request.Response, body: any) => {
            if (error) {
                reject(error);
            }
            else {
                if (httpResponse && httpResponse.statusCode > 204) {
                    reject("HTTP status code " + httpResponse.statusCode);
                }
                else {
                    resolve(body);
                }
            }
        });
    });
}