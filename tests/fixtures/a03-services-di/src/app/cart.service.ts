import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { PricingService } from './pricing.service';

@Injectable({ providedIn: 'root' })
export class CartService {
  private readonly pricing = inject(PricingService);

  constructor(private http: HttpClient) {}

  total(): number {
    return this.pricing.total([1, 2]);
  }
}
