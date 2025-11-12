export interface Entity {
  id: string;
  name: string;
}

export interface ApiResponse<T> {
  data: T;
  status: number;
}

export type EventHandler = (event: string, payload: unknown) => void;
