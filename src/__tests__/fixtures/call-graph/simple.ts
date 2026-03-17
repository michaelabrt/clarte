import { doThing } from "./helper";
import { Service } from "./service";

export function foo() {
  doThing();
}

export function bar() {
  const s = new Service();
  s.create();
}

export const baz = () => {
  doThing();
};
