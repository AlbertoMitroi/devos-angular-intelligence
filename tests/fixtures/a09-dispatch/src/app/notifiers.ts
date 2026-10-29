export abstract class Notifier {
  abstract send(text: string): void;

  prefix(): string {
    return '>';
  }
}

export class EmailNotifier extends Notifier {
  send(text: string): void {
    console.log(this.prefix() + text);
  }

  override prefix(): string {
    return 'mail>';
  }
}
