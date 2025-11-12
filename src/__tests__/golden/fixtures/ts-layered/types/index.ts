export interface BaseEntity {
  id: string;
  createdAt: Date;
}

export interface User extends BaseEntity {
  name: string;
  email: string;
}

export interface Product extends BaseEntity {
  title: string;
  price: number;
}

export type Config = {
  debug: boolean;
  port: number;
};
