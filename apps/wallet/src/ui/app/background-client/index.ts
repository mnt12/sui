// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import { Base64DataBuffer, publicKeyFromSerialized } from '@mysten/sui.js';
import { lastValueFrom, map, take } from 'rxjs';

import { growthbook } from '../experimentation/feature-gating';
import { createMessage } from '_messages';
import { PortStream } from '_messaging/PortStream';
import { type BasePayload } from '_payloads';
import { isLoadedFeaturesPayload } from '_payloads/feature-gating';
import { isKeyringPayload } from '_payloads/keyring';
import { isPermissionRequests } from '_payloads/permissions';
import { isUpdateActiveOrigin } from '_payloads/tabs/updateActiveOrigin';
import { isGetTransactionRequestsResponse } from '_payloads/transactions/ui/GetTransactionRequestsResponse';
import { setKeyringStatus } from '_redux/slices/account';
import { setActiveOrigin } from '_redux/slices/app';
import { setPermissions } from '_redux/slices/permissions';
import { setTransactionRequests } from '_redux/slices/transaction-requests';

import type {
    SignaturePubkeyPair,
    SuiAddress,
    SuiTransactionResponse,
} from '@mysten/sui.js';
import type { Message } from '_messages';
import type { KeyringPayload } from '_payloads/keyring';
import type {
    GetPermissionRequests,
    PermissionResponse,
} from '_payloads/permissions';
import type { DisconnectApp } from '_payloads/permissions/DisconnectApp';
import type { GetTransactionRequests } from '_payloads/transactions/ui/GetTransactionRequests';
import type { TransactionRequestResponse } from '_payloads/transactions/ui/TransactionRequestResponse';
import type { AppDispatch } from '_store';

/**
 * The duration in milliseconds that the UI sends status updates (active/inactive) to the background service.
 * Currently used to postpone auto locking keyring when the app is active.
 */
const APP_STATUS_UPDATE_INTERVAL = 20 * 1000;

export class BackgroundClient {
    private _portStream: PortStream | null = null;
    private _dispatch: AppDispatch | null = null;
    private _initialized = false;

    public async init(dispatch: AppDispatch) {
        if (this._initialized) {
            throw new Error('[BackgroundClient] already initialized');
        }
        this._initialized = true;
        this._dispatch = dispatch;
        this.createPortStream();
        this.sendAppStatus();
        this.setupAppStatusUpdateInterval();
        return Promise.all([
            this.sendGetPermissionRequests(),
            this.sendGetTransactionRequests(),
            this.getWalletStatus(),
            this.loadFeatures(),
        ]).then(() => undefined);
    }

    public sendPermissionResponse(
        id: string,
        accounts: SuiAddress[],
        allowed: boolean,
        responseDate: string
    ) {
        this.sendMessage(
            createMessage<PermissionResponse>({
                id,
                type: 'permission-response',
                accounts,
                allowed,
                responseDate,
            })
        );
    }

    public async sendGetPermissionRequests() {
        return lastValueFrom(
            this.sendMessage(
                createMessage<GetPermissionRequests>({
                    type: 'get-permission-requests',
                })
            ).pipe(take(1))
        );
    }

    public async sendTransactionRequestResponse(
        txID: string,
        approved: boolean,
        txResult: SuiTransactionResponse | undefined,
        tsResultError: string | undefined
    ) {
        this.sendMessage(
            createMessage<TransactionRequestResponse>({
                type: 'transaction-request-response',
                approved,
                txID,
                txResult,
                tsResultError,
            })
        );
    }

    public async sendGetTransactionRequests() {
        return lastValueFrom(
            this.sendMessage(
                createMessage<GetTransactionRequests>({
                    type: 'get-transaction-requests',
                })
            ).pipe(take(1))
        );
    }

    public async disconnectApp(origin: string) {
        await lastValueFrom(
            this.sendMessage(
                createMessage<DisconnectApp>({ type: 'disconnect-app', origin })
            ).pipe(take(1))
        );
    }

    public async createVault(password: string, importedEntropy?: string) {
        return await lastValueFrom(
            this.sendMessage(
                createMessage<KeyringPayload<'create'>>({
                    type: 'keyring',
                    method: 'create',
                    args: { password, importedEntropy },
                    return: undefined,
                })
            ).pipe(take(1))
        );
    }

    public async unlockWallet(password: string) {
        return await lastValueFrom(
            this.sendMessage(
                createMessage<KeyringPayload<'unlock'>>({
                    type: 'keyring',
                    method: 'unlock',
                    args: { password },
                    return: undefined,
                })
            ).pipe(take(1))
        );
    }

    public async lockWallet() {
        return await lastValueFrom(
            this.sendMessage(
                createMessage<KeyringPayload<'lock'>>({
                    type: 'keyring',
                    method: 'lock',
                })
            ).pipe(take(1))
        );
    }

    public async clearWallet() {
        return await lastValueFrom(
            this.sendMessage(
                createMessage<KeyringPayload<'clear'>>({
                    type: 'keyring',
                    method: 'clear',
                })
            ).pipe(take(1))
        );
    }

    public async getEntropy(password?: string) {
        return await lastValueFrom(
            this.sendMessage(
                createMessage<KeyringPayload<'getEntropy'>>({
                    type: 'keyring',
                    method: 'getEntropy',
                    args: password,
                    return: undefined,
                })
            ).pipe(
                take(1),
                map(({ payload }) => {
                    if (
                        isKeyringPayload(payload, 'getEntropy') &&
                        payload.return
                    ) {
                        return payload.return;
                    }
                    throw new Error('Mnemonic not found');
                })
            )
        );
    }

    public async setKeyringLockTimeout(timeout: number) {
        return await lastValueFrom(
            this.sendMessage(
                createMessage<KeyringPayload<'setLockTimeout'>>({
                    type: 'keyring',
                    method: 'setLockTimeout',
                    args: { timeout },
                })
            ).pipe(take(1))
        );
    }

    public async signData(
        address: SuiAddress,
        data: Base64DataBuffer
    ): Promise<SignaturePubkeyPair> {
        return await lastValueFrom(
            this.sendMessage(
                createMessage<KeyringPayload<'signData'>>({
                    type: 'keyring',
                    method: 'signData',
                    args: { data: data.toString(), address },
                })
            ).pipe(
                take(1),
                map(({ payload }) => {
                    if (
                        isKeyringPayload(payload, 'signData') &&
                        payload.return
                    ) {
                        const { signatureScheme, signature, pubKey } =
                            payload.return;
                        return {
                            signatureScheme,
                            signature: new Base64DataBuffer(signature),
                            pubKey: publicKeyFromSerialized(
                                signatureScheme,
                                pubKey
                            ),
                        };
                    }
                    throw new Error(
                        'Error unknown response for signData message'
                    );
                })
            )
        );
    }

    private setupAppStatusUpdateInterval() {
        setInterval(() => {
            this.sendAppStatus();
        }, APP_STATUS_UPDATE_INTERVAL);
    }

    private sendAppStatus() {
        const active = document.visibilityState === 'visible';
        this.sendMessage(
            createMessage<KeyringPayload<'appStatusUpdate'>>({
                type: 'keyring',
                method: 'appStatusUpdate',
                args: { active },
            })
        );
    }

    private async getWalletStatus() {
        return await lastValueFrom(
            this.sendMessage(
                createMessage<KeyringPayload<'walletStatusUpdate'>>({
                    type: 'keyring',
                    method: 'walletStatusUpdate',
                })
            ).pipe(take(1))
        );
    }

    private async loadFeatures() {
        return await lastValueFrom(
            this.sendMessage(
                createMessage<BasePayload>({
                    type: 'get-features',
                })
            ).pipe(take(1))
        );
    }

    private handleIncomingMessage(msg: Message) {
        if (!this._initialized || !this._dispatch) {
            throw new Error(
                'BackgroundClient is not initialized to handle incoming messages'
            );
        }
        const { payload } = msg;
        let action;
        if (isPermissionRequests(payload)) {
            action = setPermissions(payload.permissions);
        } else if (isGetTransactionRequestsResponse(payload)) {
            action = setTransactionRequests(payload.txRequests);
        } else if (isUpdateActiveOrigin(payload)) {
            action = setActiveOrigin(payload);
        } else if (
            isKeyringPayload<'walletStatusUpdate'>(
                payload,
                'walletStatusUpdate'
            ) &&
            payload.return
        ) {
            action = setKeyringStatus(payload.return);
        } else if (isLoadedFeaturesPayload(payload)) {
            growthbook.setFeatures(payload.features);
        }
        if (action) {
            this._dispatch(action);
        }
    }

    private createPortStream() {
        this._portStream = PortStream.connectToBackgroundService(
            'sui_ui<->background'
        );
        this._portStream.onDisconnect.subscribe(() => {
            this.createPortStream();
        });
        this._portStream.onMessage.subscribe((msg) =>
            this.handleIncomingMessage(msg)
        );
    }

    private sendMessage(msg: Message) {
        if (this._portStream?.connected) {
            return this._portStream.sendMessage(msg);
        } else {
            throw new Error(
                'Failed to send message to background service. Port not connected.'
            );
        }
    }
}
