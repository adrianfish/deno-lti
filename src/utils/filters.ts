export function buildFilter(role?: string, groupId?: string, search?: string): UserFilter | undefined {

  const filterByRole = role && role !== "all";
  const filterByGroup = groupId && groupId !== "all";
  const term = search?.trim().toLowerCase();
  const filterBySearch = !!term;

  if (!filterByRole && !filterByGroup && !filterBySearch) return undefined;

  return m => {

    if (filterByRole && !m.roles.includes(role)) return false;

    if (filterByGroup && !m.group_enrollments?.some(e => e.group_id === groupId)) return false;

    if (filterBySearch) {
      const haystack = [ m.given_name, m.family_name, m.email, m.status, m.nickname, m.pronouns, m.phoneticName, m.mobile ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(term)) return false;
    }
    return true;
  };
}
