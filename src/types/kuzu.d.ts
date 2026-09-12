declare module 'kuzu' {
  namespace kuzu {
    class Database {
      constructor(path: string, bufferSize?: number);
      close(): Promise<void>;
    }

    class Connection {
      constructor(db: Database, numThreads?: number);
      prepare(query: string): Promise<PreparedStatement>;
      execute(statement: PreparedStatement, params?: Record<string, any>): Promise<QueryResult>;
      close(): Promise<void>;
    }

    class PreparedStatement {
      isSuccess(): boolean;
      getErrorMessage(): string;
    }

    class QueryResult {
      getAll(): Promise<any[]>;
      getNext(): Promise<any>;
      hasNext(): boolean;
      resetIterator(): void;
      close(): Promise<void>;
    }
  }

  export = kuzu;
}
