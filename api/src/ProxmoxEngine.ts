import { ApiRequestable } from "./proxy";
//import fetch, { RequestInit, HeadersInit, Response } from 'node-fetch';
import querystring from 'querystring';
import reqApi, { TinyRequestBody, TinyResponse } from "@u4/tinyrequest";
// import AbortController from 'abort-controller';
import { URL } from "url";

export interface ProxmoxEngineOptionsCommon {
    host: string;
    port?: number;
    schema?: 'https' | 'http';
    authTimeout?: number;
    queryTimeout?: number;
}

export interface ProxmoxEngineOptionsPass extends ProxmoxEngineOptionsCommon {
    username?: string;
    password: string;
}

export interface ProxmoxEngineOptionsToken extends ProxmoxEngineOptionsCommon {
    tokenID: string;
    tokenSecret: string;
}

export type ProxmoxEngineOptions = ProxmoxEngineOptionsToken | ProxmoxEngineOptionsPass;

/**
 * keep the API engine there is non direct acess needed
 */
export class ProxmoxEngine implements ApiRequestable {
    public CSRFPreventionToken?: string;
    public ticket?: string;
    private username: string;
    private password: string;
    private host: string;
    private port: number;
    private schema: 'http' | 'https';
    private authTimeout: number;
    private queryTimeout: number;

    constructor(options: ProxmoxEngineOptions) {
        //if ((options as ProxmoxEngineOptionsToken).tokenID) {
        if ('tokenID' in options && options.tokenSecret) {
            //const optToken = options as ProxmoxEngineOptionsToken;
            this.username = '';
            this.password = '';
            if (!options.tokenID.match(/.*@.+\!.+/)) {
                const msg = 'invalid tokenID, format should look be like USER@REALM!TOKENID';
                console.error(msg);
                throw Error(msg)
            }
            if (!options.tokenSecret.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)) {
                const msg = 'invalid tokenSecret, format should be an lowercased UUID like 12345678-1234-1234-1234-1234567890ab';
                console.error(msg);
                throw Error(msg)
            }
            // USER@REALM!TOKENID
            this.ticket = `PVEAPIToken=${options.tokenID}=${options.tokenSecret}`;
        } else {
            const optPass = options as ProxmoxEngineOptionsPass;
            this.username = optPass.username || 'root@pam';
            this.password = optPass.password;
            if (!this.password) {
                const msg = `password is missing for Proxmox connection`;
                console.error(msg);
                throw Error(msg)
            }
        }
        this.host = options.host;
        this.port = options.port || 8006;
        this.schema = options.schema || 'https';
        this.authTimeout = options.authTimeout || 5000;
        this.queryTimeout = options.queryTimeout || 60000;
    }

    public async doRequest(httpMethod: string, path: string, pathTemplate: string, params?: { [key: string]: any }, retries?: number): Promise<any> {
        const {CSRFPreventionToken, ticket} = await this.getTicket();

        /**
         * Remove null values
         */
        if (retries && params)
            for (let k in params) {
                if (params.hasOwnProperty(k) && params[k] === null) {
                    delete params[k];
                }
            }

        let headers: {[key: string]: string} = {
        //    'Content-Type': 'application/x-www-form-urlencoded',
        };
        // use token
        if (!this.username) {
            // PVEAPIToken=USER@REALM!TOKENID=UUID  // ticket
            headers.Authorization = ticket;
        } else {
            headers.cookie = `PVEAuthCookie=${ticket}`;
            headers.CSRFPreventionToken = CSRFPreventionToken;
        }
        /**
         * Append parameters
         */

        let body: TinyRequestBody | undefined = undefined;

        let requestUrl = `${this.schema}://${this.host}:${this.port}`;
        // const httpOptions: https.RequestOptions = {host: this.host, port: this.port, path: path, method: httpMethod, headers};
        // let formBody: any = null;
        if (typeof (params) === 'object' && Object.keys(params).length > 0) {
            for (const k of Object.keys(params)) {
                const v = params[k];
                if (v === true)
                    params[k] = 1;
                else if (v === false)
                    params[k] = 0;
            }
            if (httpMethod === 'PUT' || httpMethod === 'POST') {
                // Escape unicode
                //reqBody = JSON
                //    .stringify(params)
                //    .replace(/[\u0080-\uFFFF]/g, (m) => '\\u' + ('0000' + m.charCodeAt(0).toString(16)).slice(-4)); 
                body = {form: params};
            } else {
                path += `?${querystring.stringify(params)}`
            }
        }

        requestUrl += path;

        let res: TinyResponse | null = null;
        try {
            const theUrl = new URL(requestUrl);
            res = await reqApi({
                method: httpMethod,
                protocol: theUrl.protocol,
                hostname: theUrl.hostname,
                port: theUrl.port,
                path: theUrl.pathname,
                headers,
                timeout: this.queryTimeout
            }, body);
            // const controller = new AbortController();
            // const timeout = setTimeout(() => controller.abort(), this.queryTimeout);
            // requestInit.signal = controller.signal;
            // req = await fetch(requestUrl, requestInit);
            // clearTimeout(timeout);
        } catch (e) {
            console.error(`FaILED to call ${httpMethod} ${requestUrl}`, e)
            throw Error(`FaILED to call ${httpMethod} ${requestUrl}`);
        }
        const contentType = res.headers['content-type'] as string;
        let data: { data: any, errors?: any } = { data: null };
        if (contentType === 'application/json;charset=UTF-8') {
            data = await res.json();
        } else if (!contentType) {
            data.errors = res.text;// await req.text();
        } else { // should never append
            throw Error(`${httpMethod} ${requestUrl} unexpected contentType "${contentType}" status Line:${res.statusCode} ${res.text}`);
            // data.data = req.text();
        }

        switch (res.statusCode) {
            case 400:
                throw Error(`${httpMethod} ${requestUrl} return Error ${res.statusCode} ${res.statusText}: ${JSON.stringify(data)}`);
            case 500:
                throw Error(`${httpMethod} ${requestUrl} return Error ${res.statusCode} ${res.statusText}: ${JSON.stringify(data)}`);
            case 401:
                if (res.statusText === 'invalid PVE ticket' || res.statusText === 'permission denied - invalid PVE ticket') {
                    this.ticket = undefined;
                    if (!this.username)
                        retries = 10;
                    if (!retries)
                        retries = 0;
                    retries++;
                    if (retries < 2)
                        return this.doRequest(httpMethod, path, pathTemplate, params, retries);
                }
                throw Error(`${httpMethod} ${requestUrl} return Error ${res.statusCode} ${res.statusText}: ${JSON.stringify(data)}`);
            case 200:
                return data.data;     
            default:
                throw Error(`${httpMethod} ${requestUrl} connetion failed with ${res.statusCode} ${res.statusText} return: ${JSON.stringify(data)}`);
        }
    }

    public async getTicket(): Promise<{ticket: string, CSRFPreventionToken: string}> {
        if (this.ticket && this.CSRFPreventionToken)
            return {ticket: this.ticket, CSRFPreventionToken: this.CSRFPreventionToken};
        const requestUrl = `${this.schema}://${this.host}:${this.port}/api2/json/access/ticket`;
        try {
            const password = this.password;
            const username = this.username;
            // const controller = new AbortController();
            // const timeout = setTimeout(() => controller.abort(), this.authTimeout);
            const postBody = querystring.encode({ username, password });
            const headers = {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': String(postBody.length),
            }

            const req = await reqApi({method: 'POST', host: this.host, protocol: `${this.schema}:`, port: this.port, path: '/api2/json/access/ticket', headers}, {form: { username, password }});
            // const req = await reqApi.post(requestUrl, {form: { username, password }});
            // clearTimeout(timeout);
            if (req.statusCode !== 200) {
                throw Error(`login failed with ${req.statusCode}: ${req.statusText}`);
            }
            const body = await req.json<{data:{cap:any, ticket: string, CSRFPreventionToken: string, username: string}}>();
            const { CSRFPreventionToken, ticket } = body.data;
            this.CSRFPreventionToken = CSRFPreventionToken;
            this.ticket = ticket;
            return {ticket, CSRFPreventionToken};
        } catch (e) {
            console.log(e);
            throw Error(`Auth ${requestUrl} Failed! with Exception: ${e}`);
        }
    }
}

export default ProxmoxEngine;