import { Component, inject } from '@angular/core';
import { Store } from '@ngrx/store';
import { loadOrders } from './orders.actions';

@Component({ selector: 'app-orders-page', template: '<button (click)="refresh()">Load</button>' })
export class OrdersPageComponent {
  private store = inject(Store);

  refresh(): void {
    this.store.dispatch(loadOrders());
  }
}
