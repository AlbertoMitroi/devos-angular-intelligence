import { Component, inject } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { environment } from '../environments/environment';

@Component({ selector: 'app-reports', template: '<p>reports</p>' })
export class ReportsComponent {
  private http = inject(HttpClient);
  private readonly fallbackKey = 'fixture-inline-secret-key-0042';

  load() {
    const headers = new HttpHeaders({ 'x-api-key': environment.apiKey || this.fallbackKey });
    return this.http.get(`${environment.apiUrl}/reports`, { headers });
  }
}
