declare module "mysql2/promise" {
  export interface FieldPacket { name: string; }
  export interface ResultSetHeader { affectedRows: number; }
  export interface Connection {
    query(sql: string): Promise<[unknown, FieldPacket[]]>;
    execute(sql: string): Promise<[unknown, FieldPacket[]]>;
    end(): Promise<void>;
  }
  export function createConnection(options: Record<string, unknown>): Promise<Connection>;
}
