declare module "ssh2" {
  import { EventEmitter } from "node:events";
  import { Readable } from "node:stream";

  export interface ClientConnectConfig {
    readonly host: string;
    readonly port?: number;
    readonly username: string;
    readonly privateKey: Buffer;
    readonly readyTimeout?: number;
    readonly keepaliveInterval?: number;
    readonly keepaliveCountMax?: number;
    readonly hostVerifier?: (key: Buffer) => boolean;
  }

  export interface ClientChannel extends Readable {
    readonly stderr: Readable;
  }

  export class Client extends EventEmitter {
    connect(config: ClientConnectConfig): this;
    exec(
      command: string,
      callback: (error: Error | undefined, stream?: ClientChannel) => void,
    ): void;
    end(): void;
    destroy(): this;
  }

  interface ParsedKey {
    isPrivateKey(): boolean;
  }

  interface Ssh2Utils {
    parseKey(keyData: Buffer | string, passphrase?: string): ParsedKey | ParsedKey[] | Error;
  }

  export const utils: Ssh2Utils;
  const ssh2: { readonly Client: typeof Client; readonly utils: Ssh2Utils };
  export default ssh2;
}
