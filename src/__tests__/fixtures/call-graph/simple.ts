import { doThing } from "./helper.js";
import { Service } from "./service.js";

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
