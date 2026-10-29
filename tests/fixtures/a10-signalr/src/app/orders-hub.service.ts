import { Injectable } from '@angular/core';
import { HubConnection, HubConnectionBuilder } from '@microsoft/signalr';
import { environment } from '../environments/environment';

@Injectable({ providedIn: 'root' })
export class OrdersHubService {
  private connection: HubConnection;

  constructor() {
    this.connection = new HubConnectionBuilder()
      .withUrl(`${environment.hubUrl}/hubs/orders`)
      .build();
  }

  start(onShipped: (id: string) => void): Promise<void> {
    this.connection.on('OrderShipped', onShipped);
    return this.connection.start();
  }

  subscribe(orderId: string): Promise<void> {
    return this.connection.invoke('Subscribe', orderId);
  }

  ping(): Promise<void> {
    return this.connection.send('Ping');
  }
}
