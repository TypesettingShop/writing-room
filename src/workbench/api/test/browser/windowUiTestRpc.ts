import { RPCProtocol } from '../../../services/extensions/common/rpcProtocol.js';

/**
 * A message port pair for DOM tests: jsdom's `MessageEvent` cannot wrap the data of Node's ports. Each
 * message is structured-cloned and delivered in order in a later task, as a real port does.
 */
class TestPort extends EventTarget {
  other!: TestPort;
  private closed = false;

  postMessage(value: unknown): void {
    if (this.closed) {
      return;
    }
    const data = structuredClone(value);
    setTimeout(() => {
      if (!this.other.closed) {
        this.other.dispatchEvent(new MessageEvent('message', { data }));
      }
    }, 0);
  }

  start(): void {}

  close(): void {
    this.closed = true;
  }
}

export function createDomRpcPair() {
  const port1 = new TestPort();
  const port2 = new TestPort();
  port1.other = port2;
  port2.other = port1;
  const main = new RPCProtocol(port1 as unknown as MessagePort);
  const worker = new RPCProtocol(port2 as unknown as MessagePort);
  return { main, worker, dispose: () => { main.dispose(); worker.dispose(); } };
}

/** Lets messages in flight arrive, and their replies. */
export async function settle(rounds = 6): Promise<void> {
  for (let index = 0; index < rounds; index++) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}
