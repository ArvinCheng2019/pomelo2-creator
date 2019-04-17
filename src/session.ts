
import { EventEmitter } from 'events';
import URLParse from 'url-parse';
import { websocket } from './sockets/websocket';
import * as is from 'is';

import { Protobuf } from './protobuf';
import { Protocol } from './protocol';


const JS_WS_CLIENT_TYPE = 'cocos-creator-api';
const JS_WS_CLIENT_VERSION = '0.0.1';

declare interface Socket {
    connected: number;
    connectting: number;

    connect(uri: string): Promise<Socket | undefined>;
    send(buffer: Uint8Array): void;
    close(code: number, reason: string): void;

    on(event: string, listener: (...args: any[]) => void): void;
    once(event: string, listener: (...args: any[]) => void): void;
}

declare interface Option {
    auth(): Promise<object | undefined>;
    retry?: number;
    localstorage: {
        getItem(key: string): any | undefined;
        setItem(key: string, value: any, exipre?: number): any;
    },
    decodeIO?: boolean;
    rsa?: string;
    usr?: object;
}

const RES_OK = 200;
const RES_FAIL = 500;
const RES_OLD_CLIENT = 501;

export class Session extends EventEmitter {
    protected id: string = '';
    protected socket: Socket | undefined;

    private protoVersion: string = '';
    private serverProtos: any = {};
    private clientProtos: any = {};
    private dict: any = {};
    private routeMap: any = {};
    private abbrs: any = {};

    private heartbeatInterval: number = 0;
    private heartbeatTimeout: number = 0;
    private nextHeartbeatTimeout: number = 0;
    private heartbeatTimeoutId: any = 0;
    private heartbeatId: any = 0;

    private _remote: URLParse;
    private _listeners: { [name: string]: EventEmitter } = {};
    private opts: Option;
    private handshakeBuffer: any;

    protected retryCounter: number = 0;
    protected retryTimer: any = 0;

    protected reqId: number = 0;
    protected callbacks: { [id: string]: { resolve: Function, reject: Function } } = {};
    constructor(uri: string, opts: Option) {
        super();
        this._remote = URLParse(uri);
        this.opts = opts;

        const protos = opts.localstorage.getItem('protos');
        if (protos) {
            this.protoVersion = protos.version || '';
            this.serverProtos = protos.server || {};
            this.clientProtos = protos.client || {};
            Protobuf.init({
                encoderProtos: this.clientProtos,
                decoderProtos: this.serverProtos
            });
        }

        this.handshakeBuffer = {
            sys: {
                type: JS_WS_CLIENT_TYPE,
                version: JS_WS_CLIENT_VERSION,
                rsa: {},
                protoVersion: this.protoVersion
            },
            user: {}
        };

        this.connect();

        this.on('reconnect', () => {
            this.retryTimer = setTimeout(this.connect.bind(this), (this.retryCounter % 10 + 1) * 1000);
            this.retryCounter++;
        });
    }

    private async connect() {
        if (this.socket && (this.socket.connectting || this.socket.connected)) {
            return;
        }

        switch (this._remote.protocol) {
            case 'ws:':
            case 'wss:':
                this.socket = new websocket();
                break;
            default:
                throw new Error('un support socket protocol!');
        }

        this.socket.on('error', this.emit.bind(this, 'error'));
        this.socket.on('message', this.processPackage.bind(this));
        this.socket.on('closed', () => {
            delete this.socket;
            this.socket = undefined;

            if (this.opts.retry && this.opts.retry < this.retryCounter) {
                return;
            }

            this.emit('reconnect');
        });

        this.socket.on('connected', () => {
            this.retryCounter = 0;
            if (this.socket) {
                this.socket.send(Protocol.Package.encode(Protocol.PackageType.TYPE_HANDSHAKE, Protocol.strencode(JSON.stringify(this.handshakeBuffer))));
            }
        });

        this.socket.connect(this._remote.href);
    }

    when(channel: string, event: string, listener: (...args: any[]) => void) {
        if (!this._listeners[channel]) {
            this._listeners[channel] = new EventEmitter();
            this._listeners[channel].emit = this.emit.bind(this);
        }

        this._listeners[channel].on(event, listener);
    }


    cleanup(channel?: string) {
        if (channel && this._listeners[channel]) {
            this._listeners[channel].removeAllListeners();
            delete this._listeners[channel];
        }
    }

    asyncEvent(event: string, timeout: number = 5000) {
        return new Promise((s, r) => {
            const timer = setTimeout(r, timeout);
            this.once(event, (data: any) => {
                if (timer) {
                    clearTimeout(timer);
                }
                s(data);
            });
        });
    }

    async request(route: string, msg: object) {
        if (!this.socket) {
            await this.connect();
        }

        if (!this.socket) {
            return Promise.reject(new Error('socket invalid status!'));
        }

        if (this.socket.connectting) {
            await this.asyncEvent('ready');
        }

        this.reqId++;

        const body = this._encode(this.reqId, route, msg);
        if (body) {
            await this.socket.send(Protocol.Package.encode(Protocol.PackageType.TYPE_DATA, body));
        }

        return await new Promise((resolve, reject) => {
            this.callbacks[this.reqId] = { resolve, reject };
            this.routeMap[this.reqId] = route;
        });
    }

    async notify(route: string, msg: object) {
        if (!this.socket) {
            await this.connect();
        }

        if (this.socket && this.socket.connectting) {
            await this.asyncEvent('ready');
        }

        const body = this._encode(0, route, msg);
        if (this.socket && body) {
            await this.socket.send(Protocol.Package.encode(Protocol.PackageType.TYPE_DATA, body));
        }
    }

    async disconnect(code: number, reason: string) {
        if (this.heartbeatId) {
            clearTimeout(this.heartbeatId);
        }

        if (this.heartbeatTimeoutId) {
            clearTimeout(this.heartbeatTimeoutId);
        }

        if (this.socket) {
            this.socket.close(code, reason);
            this.socket = undefined;
        }
    }


    private async processPackage(buffer: Uint8Array) {
        const msgs = Protocol.Package.decode(buffer);
        if (!msgs) {
            if (this.socket)
                this.socket.close(-1, 'socket read EOF!');
            return;
        }

        for (let i in msgs) {
            const msg = msgs[i];
            switch (msg.type) {
                case Protocol.PackageType.TYPE_HANDSHAKE:
                    await this.onHandshake(msg.body);
                    await this.auth();
                    break;
                case Protocol.PackageType.TYPE_HEARTBEAT:
                    this.onHeartbeat();
                    break;
                case Protocol.PackageType.TYPE_DATA:
                    this.onMessage(msg.body);
                    break;
                case Protocol.PackageType.TYPE_KICK:
                    this.onKickout(msg.body);
                    break;
                default:
                    throw new Error('invalid message type!');
            }
        }
    }

    private async onHandshake(body?: Uint8Array | null) {
        if (!body) {
            return;
        }

        const msg = JSON.parse(Protocol.strdecode(body));
        if (msg.code === RES_OLD_CLIENT) {
            this.emit('error', new Error('invalid version'));
            return;
        }
        if (msg.code !== RES_OK) {
            this.emit('error', new Error('handshake failed'));
        }

        if (msg.sys && msg.sys.heartbeat) {
            this.heartbeatInterval = msg.sys.heartbeat * 1000; // heartbeat interval
            this.heartbeatTimeout = this.heartbeatInterval * 5; // max heartbeat timeout
        }
        if (msg.sys.id) {
            this.id = msg.sys.id;
        }

        this.dict = msg.sys.dict;
        const protos = msg.sys.protos;
        //Init compress dict
        if (this.dict) {
            this.abbrs = {};
            for (let route in this.dict) {
                this.abbrs[this.dict[route]] = route;
            }
        }
        //Init protobuf protos
        if (protos) {
            this.protoVersion = protos.version || 0;
            this.serverProtos = protos.server || {};
            this.clientProtos = protos.client || {};
            //Save protobuf protos to localStorage
            this.opts.localstorage.setItem('protos', JSON.stringify(protos));
            Protobuf.init({ encoderProtos: protos.client, decoderProtos: protos.server });
        }
        if (this.socket)
            this.socket.send(Protocol.Package.encode(Protocol.PackageType.TYPE_HANDSHAKE_ACK));
    }

    private async onHeartbeat() {
        if (!this.heartbeatInterval || this.heartbeatId) {
            return;
        }

        if (this.heartbeatTimeoutId) {
            clearTimeout(this.heartbeatTimeoutId);
        }

        this.heartbeatId = setTimeout(() => {
            this.heartbeatId = null;
            if (this.socket) {
                this.socket.send(Protocol.Package.encode(Protocol.PackageType.TYPE_HEARTBEAT));
            }
            this.nextHeartbeatTimeout = Date.now() + this.heartbeatTimeout;
            this.heartbeatTimeoutId = setTimeout(() => {
                if (this.socket)
                    this.socket.close(-1, 'heartbeat timeout!');
            }, this.heartbeatTimeout);

        }, this.heartbeatInterval);
    }


    private async onMessage(body?: Uint8Array | null) {
        if (!body) {
            return;
        }

        const msg = this._decode(body);
        if (!msg) {
            return;
        }

        if (!msg.id && msg.route) {
            this.emit(msg.route.toString(), msg.body);
            return;
        }

        if (this.callbacks[msg.id]) {
            this.callbacks[msg.id].resolve(msg.body);
            delete this.callbacks[msg.id];
        }
    }

    private async onKickout(body?: Uint8Array | null) {
        if (!body) {
            return;
        }
        const reason = JSON.parse(Protocol.strdecode(body));
        this.emit('kickout', reason);
    }

    private _encode(reqId: number, route: string, msg: any) {
        if (this.clientProtos[route]) {
            msg = Protobuf.encode(route, msg);
        }
        else {
            msg = Protocol.strencode(JSON.stringify(msg));
        }
        return Protocol.Message.encode(reqId, reqId ? Protocol.MessageType.TYPE_REQUEST : Protocol.MessageType.TYPE_NOTIFY, this.dict[route], this.dict[route], msg, false);
    }

    private _decode(buffer: Uint8Array) {
        const msg = Protocol.Message.decode(buffer);
        if (msg.id > 0) {
            msg.route = this.routeMap[msg.id];
            delete this.routeMap[msg.id];
            if (!msg.route) {
                return;
            }
        }

        const canver = (msg: any) => {
            let route = msg.route;
            //Decompose route from dict
            if (msg.compressRoute) {
                if (!this.abbrs[route]) {
                    return {};
                }

                route = msg.route = this.abbrs[route];
            }
            if (this.serverProtos[route]) {
                return Protobuf.decode(route, msg.body);
            }
            else {
                return JSON.parse(Protocol.strdecode(msg.body));
            }
        };

        msg.body = canver(msg);
        return msg;
    }

    async auth() {
        if (this.opts.auth) {
            const response = await this.opts.auth();
            if (response) {
                this.emit('ready', response);
            }
            return response;
        }
    }
} 