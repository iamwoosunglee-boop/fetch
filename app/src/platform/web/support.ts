/** The web build supports desktop Chrome and Edge only; other browsers get a notice and no model download. */
export function supportedWebEnvironment(userAgent: string, width: number): boolean {
  return width >= 480 && /(?:Chrome|Edg)\//.test(userAgent)
    && !/Mobile|Android|iPhone|iPad|OPR\//.test(userAgent);
}
