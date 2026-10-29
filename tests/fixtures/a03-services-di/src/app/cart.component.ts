import { Component } from '@angular/core';
import { CartService } from './cart.service';
import { AuditLog } from './audit-log';

@Component({
  selector: 'app-cart',
  template: '<p>{{ cart.total() }}</p>',
})
export class CartComponent {
  constructor(public cart: CartService, private audit: AuditLog) {}
}
