export type BotDeviceAccess = {supported: true; enabled: boolean; endpoint: string; fingerprint: string; error: string; pendingCount: number};
export type BotDevice = {id: string; name: string; createdAt: number; lastConnectedAt: number | null; revokedAt: number | null};
export type BotPairRequest = {requestId: string; deviceId: string; name: string; code: string; status: string; publicKey: {kty: string; crv: string; x: string; y: string}};
export type BotPairInvitation = {inviteId: string; expiresAt: number; status: string; request: BotPairRequest | null; qr?: string};
export type BotPairStatus = BotDeviceAccess & {invitation: BotPairInvitation | null; devices: BotDevice[]};
export type BotPairInvite = {type: 'hemi-bot-pair'; version: 1; endpoint: string; botInstanceId: string; inviteId: string; requestTicket: string; expiresAt: number; certificatePin: string};
