import { Component, inject } from '@angular/core';
import { OrdersHubService } from './orders-hub.service';

@Component({ selector: 'app-live', template: '<p>live</p>' })
export class LiveComponent {
  hub = inject(OrdersHubService);
}
