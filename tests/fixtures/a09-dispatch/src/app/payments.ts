export interface PaymentGateway {
  charge(amount: number): boolean;
}

export class StripeGateway implements PaymentGateway {
  charge(amount: number): boolean {
    return amount > 0;
  }
}

export class PaypalGateway implements PaymentGateway {
  charge(amount: number): boolean {
    return amount < 1000;
  }
}
