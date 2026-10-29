import { Component } from '@angular/core';
import { OrdersService } from './orders.service';

@Component({ selector: 'app-orders', template: '<p>orders</p>' })
export class OrdersComponent {
  constructor(private orders: OrdersService) {}
}
