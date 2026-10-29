import { Injectable } from '@angular/core';

@Injectable()
export class AuditLog {
  write(message: string): void {
    console.log(message);
  }
}
