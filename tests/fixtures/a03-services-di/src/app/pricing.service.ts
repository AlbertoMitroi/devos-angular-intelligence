import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class PricingService {
  total(prices: number[]): number {
    return prices.reduce((a, b) => a + b, 0);
  }
}
