import { Service } from "./service";

export class Controller {
  private svc: Service;

  constructor() {
    this.svc = new Service();
  }

  handle(): void {
    this.svc.create();
  }

  static bootstrap(): Controller {
    return new Controller();
  }
}
