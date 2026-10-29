import { Component, inject } from '@angular/core';
import { StatusService } from './status.service';

@Component({ selector: 'app-status', template: '<p>status</p>' })
export class StatusComponent {
  status = inject(StatusService);
}
