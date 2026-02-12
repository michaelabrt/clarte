import { doThing } from "./helper.js";

export const arrowFn = () => {
  doThing();
};

export const outerArrow = () => {
  const inner = () => {
    doThing();
  };
  inner();
};
