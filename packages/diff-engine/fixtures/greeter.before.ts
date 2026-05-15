export interface Greeter {
  greet(name: string): string;
}

export class FriendlyGreeter implements Greeter {
  greet(name: string): string {
    return `Hello, ${name}`;
  }
}
