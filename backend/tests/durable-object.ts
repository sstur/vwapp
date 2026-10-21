/** Minimal runtime shell; storage behavior is exercised separately through Wrangler smoke tests. */
export class DurableObject<Env> {
  constructor(
    public ctx: DurableObjectState,
    public env: Env,
  ) {}
  fetch(_request: Request): Promise<Response> {
    void _request;
    throw new Error("not implemented");
  }
  alarm(): Promise<void> {
    throw new Error("not implemented");
  }
}
