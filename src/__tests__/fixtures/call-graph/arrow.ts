import { doThing } from "./helper";

export const arrowFn = () => {
  doThing();
};

export const outerArrow = () => {
  const inner = () => {
    doThing();
  };
  inner();
};
