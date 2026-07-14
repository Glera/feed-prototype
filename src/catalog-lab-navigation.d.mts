export interface CatalogLabRouteSources {
  search?: string;
  startParam?: unknown;
}

export function catalogLabAuthorizationAvailable(value: unknown): boolean;
export function catalogLabAuthRequested(sources?: CatalogLabRouteSources): boolean;
export function catalogLabOpenedFromFeed(search?: string): boolean;
export function catalogLabAuthUrl(href: string): string;
export function catalogFeedUrl(href: string): string;
