import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';

@Injectable({ providedIn: 'root' })
export class OrdersApi {
  private http = inject(HttpClient);

  list() {
    return this.http.get<string[]>('/api/orders');
  }
}
