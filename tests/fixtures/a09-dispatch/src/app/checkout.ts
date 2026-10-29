import { PaymentGateway } from './payments';
import { Notifier } from './notifiers';

export function format(value: string): string;
export function format(value: number): string;
export function format(value: string | number): string {
  return String(value);
}

export class Checkout {
  constructor(private gateway: PaymentGateway, private notifier: Notifier) {}

  run(): void {
    if (this.gateway.charge(10)) {
      this.notifier.send(format(10));
    }
  }
}
