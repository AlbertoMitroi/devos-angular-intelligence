import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';

@Injectable({ providedIn: 'root' })
export class StatusService {
  private http = inject(HttpClient);

  orders() {
    return this.http.get('/api/orders');
  }

  health() {
    return this.http.get('/health');
  }
}
