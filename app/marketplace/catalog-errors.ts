/** A missing manifest is normal for installed content from an older/different catalog. */
export class CatalogTemplateUnavailableError extends Error {
  constructor(type: string, id: string, options?: ErrorOptions) {
    super(`Catalog template ${type}/${id} is no longer available.`, options);
    this.name = "CatalogTemplateUnavailableError";
  }
}
