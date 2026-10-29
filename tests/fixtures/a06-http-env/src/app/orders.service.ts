import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../environments/environment';

const CATALOG = '/catalog';

@Injectable({ providedIn: 'root' })
export class OrdersService {
  private readonly base = `${environment.apiUrl}/orders`;

  constructor(private http: HttpClient) {}

  get(id: string) {
    return this.http.get(`${this.base}/${id}`);
  }

  create(body: unknown) {
    return this.http.post(environment.apiUrl + '/Orders', body);
  }

  items() {
    return this.http.get(CATALOG + '/items?page=1');
  }

  remove(id: string) {
    return this.http.request('DELETE', `${environment.apiUrl}/orders/${id}`);
  }

  dynamic(url: string) {
    return this.http.get(url);
  }
}
