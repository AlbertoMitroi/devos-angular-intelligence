import { Component, Inject, inject } from '@angular/core';
import { API_URL, Clock, ConsoleLogger, Logger } from './tokens';

@Component({
  selector: 'app-root',
  template: '<p>{{ url }}</p>',
  providers: [ConsoleLogger, { provide: Logger, useExisting: ConsoleLogger }],
})
export class AppComponent {
  private readonly clock = inject(Clock);

  constructor(@Inject(API_URL) public url: string, private logger: Logger) {
    this.logger.log(String(this.clock.now()));
  }
}
