import { Emitter } from '../../../../base/common/event.js';
import { ExtensionHostMessage } from '../common/extensionHostProtocol.js';
import type { HostControlMessage, HostExtensionDescription } from '../common/extensionHostProtocol.js';
import { RPCProtocol } from '../common/rpcProtocol.js';

const startupTimeout = 60_000;
const heartbeatInterval = 2_000;
const heartbeatTimeout = 8_000;
const shutdownTimeout = 5_000;

export class WebWorkerExtensionHost {
  private readonly worker = new Worker(new URL('../../../api/worker/extensionHostWorkerMain.ts', import.meta.url), {
    type: 'module', name: 'writing-room-extension-host',
  });
  private readonly channel = new MessageChannel();
  readonly rpc = new RPCProtocol(this.channel.port1);

  private readonly exit = new Emitter<Error>();
  readonly onDidExit = this.exit.event;
  readonly ready: Promise<void>;
  private rejectReady!: (error: Error) => void;
  private stopped = false;
  private timer: number | undefined;
  private heartbeat: number | undefined;
  private deadline: number | undefined;
  private shutdownTimer: number | undefined;

  constructor(extensions: readonly HostExtensionDescription[]) {
    const port = this.channel.port1;
    this.ready = new Promise((resolve, reject) => {
      this.rejectReady = reject;
      let initializing = false;
      this.timer = window.setTimeout(() => this.fail('Extension host startup timed out.'), startupTimeout);
      port.addEventListener('message', ({ data }: MessageEvent<HostControlMessage>) => {
        if (this.shutdownTimer !== undefined) {
          if (data.kind === ExtensionHostMessage.Terminated) {
            this.dispose();
          }
          return;
        }
        if (data.kind === ExtensionHostMessage.Ready && !initializing) {
          initializing = true;
          this.send({ kind: ExtensionHostMessage.Initialize, extensions: [...extensions] });
        } else if (data.kind === ExtensionHostMessage.Initialized && initializing && this.timer !== undefined) {
          window.clearTimeout(this.timer);
          this.timer = undefined;
          resolve();
          this.monitor();
        }
      });
      port.addEventListener('messageerror', () => this.fail('Extension host message could not be read.'));
      port.addEventListener('close', () => this.fail('Extension host closed its channel.'));
      this.worker.addEventListener('error', event => {
        event.preventDefault();
        this.fail(event.message || 'Extension host worker crashed.');
      });
      this.worker.addEventListener('messageerror', () => this.fail('Extension host could not read the startup message.'));
      try {
        this.worker.postMessage('connect', [this.channel.port2]);
      } catch (error) {
        this.fail(String(error));
      }
    });
  }

  private monitor(): void {
    let sequence = 0;
    this.channel.port1.addEventListener('message', ({ data }: MessageEvent<HostControlMessage>) => {
      if (data.kind === ExtensionHostMessage.Pong && data.sequence === sequence) {
        window.clearTimeout(this.deadline);
        this.deadline = undefined;
      }
    });
    this.heartbeat = window.setInterval(() => {
      if (this.deadline !== undefined || document.hidden) {
        return;
      }
      this.send({ kind: ExtensionHostMessage.Ping, sequence: ++sequence });
      this.deadline = window.setTimeout(() => {
        this.deadline = undefined;
        if (!document.hidden) {
          this.fail('Extension host stopped responding.');
        }
      }, heartbeatTimeout);
    }, heartbeatInterval);
  }

  private send(message: HostControlMessage): void {
    if (!this.stopped) {
      try {
        this.channel.port1.postMessage(message);
      } catch (error) {
        this.fail(String(error));
      }
    }
  }

  private fail(message: string): void {
    this.stop(new Error('The extension host is not running. ' + message), true);
  }

  private clearMonitoringTimers(): void {
    window.clearTimeout(this.timer);
    window.clearInterval(this.heartbeat);
    window.clearTimeout(this.deadline);
  }

  private stop(error: Error, terminateImmediately: boolean): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.clearMonitoringTimers();
    window.clearTimeout(this.shutdownTimer);
    if (terminateImmediately) {
      this.worker.terminate();
    }
    this.rpc.dispose(error);
    this.rejectReady(error);
    this.exit.fire(error);
    this.exit.dispose();
  }

  dispose(): void {
    this.stop(new Error('The extension host is not running.'), true);
  }

  shutdownGracefully(): Promise<void> {
    if (this.stopped) {
      return Promise.resolve();
    }
    return new Promise(resolve => {
      this.onDidExit(() => resolve());
      if (this.shutdownTimer === undefined) {
        this.clearMonitoringTimers();
        this.shutdownTimer = window.setTimeout(() => this.dispose(), shutdownTimeout);
        // Panel notifications are already queued. Disable old API calls while keeping the
        // control channel available for the worker to acknowledge its shutdown.
        this.rpc.stop(new Error('The extension host is not running.'));
        this.send({ kind: ExtensionHostMessage.Terminate });
      }
    });
  }

  shutdown(): void {
    this.send({ kind: ExtensionHostMessage.Terminate });
    this.stop(new Error('The extension host is not running.'), false);
  }
}
