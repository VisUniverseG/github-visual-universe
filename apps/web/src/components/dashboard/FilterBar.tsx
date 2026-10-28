import { useId } from 'react';
import {
  type Filters,
  type OwnershipFilter,
  type SortOrder,
  type VisibilityFilter,
} from '../../dashboard/filters.ts';

export interface LanguageOption {
  readonly value: string;
  readonly label: string;
}

interface Props {
  readonly filters: Filters;
  readonly onChange: (next: Filters) => void;
  readonly onReset: () => void;
  readonly canReset: boolean;
  readonly languageOptions: readonly LanguageOption[];
  /** Whether personal / other-account ownership can be evaluated (the signed-in login is known). */
  readonly ownershipAvailable: boolean;
  readonly showOther: boolean;
}

export function FilterBar({
  filters,
  onChange,
  onReset,
  canReset,
  languageOptions,
  ownershipAvailable,
  showOther,
}: Props) {
  const id = useId();

  return (
    <form
      className="filters"
      role="search"
      aria-label="Search and filter repositories"
      onSubmit={(event) => {
        event.preventDefault();
      }}
    >
      <div className="field field-search">
        <label htmlFor={`${id}-q`}>Search by name</label>
        <input
          id={`${id}-q`}
          type="search"
          value={filters.query}
          placeholder="Repository name"
          autoComplete="off"
          onChange={(event) => {
            onChange({ ...filters, query: event.target.value });
          }}
        />
      </div>

      <div className="field">
        <label htmlFor={`${id}-vis`}>Visibility</label>
        <select
          id={`${id}-vis`}
          value={filters.visibility}
          onChange={(event) => {
            onChange({ ...filters, visibility: event.target.value as VisibilityFilter });
          }}
        >
          <option value="all">All</option>
          <option value="public">Public</option>
          <option value="private">Private</option>
        </select>
      </div>

      <div className="field">
        <label htmlFor={`${id}-own`}>Owner</label>
        <select
          id={`${id}-own`}
          value={filters.ownership}
          onChange={(event) => {
            onChange({ ...filters, ownership: event.target.value as OwnershipFilter });
          }}
        >
          <option value="all">All</option>
          <option value="personal" disabled={!ownershipAvailable}>
            Personal
          </option>
          <option value="organization">Organization</option>
          {showOther && (
            <option value="other" disabled={!ownershipAvailable}>
              Other accounts
            </option>
          )}
        </select>
      </div>

      <div className="field">
        <label htmlFor={`${id}-lang`}>Language</label>
        <select
          id={`${id}-lang`}
          value={filters.language}
          onChange={(event) => {
            onChange({ ...filters, language: event.target.value });
          }}
        >
          <option value="all">All</option>
          {languageOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor={`${id}-sort`}>Sort by</label>
        <select
          id={`${id}-sort`}
          value={filters.sort}
          onChange={(event) => {
            onChange({ ...filters, sort: event.target.value as SortOrder });
          }}
        >
          <option value="name">Name</option>
          <option value="updated">Recently updated</option>
        </select>
      </div>

      <div className="field field-reset">
        <button type="button" onClick={onReset} disabled={!canReset}>
          Reset filters
        </button>
      </div>
    </form>
  );
}
