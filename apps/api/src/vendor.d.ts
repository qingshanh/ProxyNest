declare module 'sql.js' {
  export type BindParams = Array<string | number | Uint8Array | null>

  export interface Statement {
    bind(values?: BindParams): boolean
    step(): boolean
    getAsObject(): Record<string, string | number | Uint8Array | null>
    free(): boolean
  }

  export class Database {
    constructor(data?: Uint8Array)
    run(sql: string, params?: BindParams): Database
    exec(sql: string): unknown[]
    prepare(sql: string): Statement
    export(): Uint8Array
    close(): void
  }

  export interface SqlJsStatic {
    Database: typeof Database
  }

  export default function initSqlJs(config?: {
    locateFile?: (file: string) => string
  }): Promise<SqlJsStatic>
}
