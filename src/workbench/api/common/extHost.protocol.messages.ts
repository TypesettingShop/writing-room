import { createProxyIdentifier } from '../../services/extensions/common/proxyIdentifier.js';

export type MessageSeverity = 'info' | 'warning' | 'error';

export interface MainThreadMessageServiceShape {
  $showMessage(extension: string, severity: MessageSeverity, message: string, actions: string[]): Promise<number | undefined>;
}

export const MainThreadMessageServiceProxy = createProxyIdentifier<MainThreadMessageServiceShape>('MainThreadMessageService');
