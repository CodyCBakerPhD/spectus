"""
The GraphQL queries a scan makes.

Each asks for `rateLimit` alongside its data so the scan can report what it spent. Several are built for a batch of
ids at once, since one query over many nodes costs about as much as a query over one.
"""

PAGE_SIZE = 100
# The most nodes `nodes(ids:)` accepts at once
MAXIMUM_IDS = 100
# Workflow runs per page when listing the runs of a workflow
RUNS_PAGE_SIZE = 25
# Workflows listed per query; each of them is a separately paginated connection
WORKFLOWS_PER_QUERY = 25
# Runs whose details are fetched per query; each brings up to CHECK_RUNS_PER_RUN jobs with it
RUN_DETAILS_PER_QUERY = 50
CHECK_RUNS_PER_RUN = 100

_RATE_LIMIT = "rateLimit { cost remaining }"

OWNER_REPOSITORIES = f"""
query ($login: String!, $after: String, $isFork: Boolean) {{
  {_RATE_LIMIT}
  repositoryOwner(login: $login) {{
    repositories(
      first: {PAGE_SIZE}
      after: $after
      privacy: PUBLIC
      isFork: $isFork
      ownerAffiliations: [OWNER]
      orderBy: {{field: NAME, direction: ASC}}
    ) {{
      pageInfo {{ hasNextPage endCursor }}
      nodes {{ nameWithOwner }}
    }}
  }}
}}
"""

RUN_DETAILS = f"""
query ($ids: [ID!]!) {{
  {_RATE_LIMIT}
  nodes(ids: $ids) {{
    ... on WorkflowRun {{
      id
      databaseId
      runNumber
      event
      createdAt
      updatedAt
      url
      file {{ path }}
      workflow {{ name }}
      checkSuite {{
        status
        conclusion
        branch {{ name }}
        commit {{ oid }}
        creator {{ login }}
        repository {{ nameWithOwner }}
        checkRuns(first: {CHECK_RUNS_PER_RUN}, filterBy: {{checkType: LATEST}}) {{
          nodes {{ startedAt completedAt }}
        }}
      }}
    }}
  }}
}}
"""


def repositories_query(names: list[str], /) -> tuple[str, dict[str, str]]:
    """
    Build a query that looks up each `owner/name`, under the alias `r{index}`.

    Renamed repositories are followed to their current name, which the query returns as `nameWithOwner`.
    """
    arguments = ", ".join(f"$owner{index}: String!, $name{index}: String!" for index in range(len(names)))
    fields = "\n".join(
        f"  r{index}: repository(owner: $owner{index}, name: $name{index}) {{ nameWithOwner }}"
        for index in range(len(names))
    )
    variables: dict[str, str] = {}
    for index, name in enumerate(names):
        variables[f"owner{index}"], _, variables[f"name{index}"] = name.partition("/")
    return f"query ({arguments}) {{\n  {_RATE_LIMIT}\n{fields}\n}}\n", variables


def workflow_runs_query(pages: list[tuple[str, str | None]], /) -> tuple[str, dict[str, str | None]]:
    """
    Build a query for one page of the newest runs of each workflow, under the alias `w{index}`.

    Parameters
    ----------
    pages : list of (str, str or None)
        The node id of each workflow and the cursor after which its page starts (None for its first page).

    """
    arguments = ", ".join(f"$id{index}: ID!, $after{index}: String" for index in range(len(pages)))
    fields = "\n".join(
        f"  w{index}: node(id: $id{index}) {{ ... on Workflow {{ runs(first: {RUNS_PAGE_SIZE}, after: $after{index}) "
        "{ pageInfo { hasNextPage endCursor } nodes { id databaseId createdAt updatedAt checkSuite { status } } } } }"
        for index in range(len(pages))
    )
    variables: dict[str, str | None] = {}
    for index, (workflow_id, after) in enumerate(pages):
        variables[f"id{index}"] = workflow_id
        variables[f"after{index}"] = after
    return f"query ({arguments}) {{\n  {_RATE_LIMIT}\n{fields}\n}}\n", variables
