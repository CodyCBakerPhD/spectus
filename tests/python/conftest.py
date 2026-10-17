import datetime
import pathlib

import pytest

from spectus.cache import Cache
from spectus.config import Config
from spectus.github import GitHubClient
from spectus.scan import Scanner
from spectus.storage import DataStore

from .fake_github import FakeGitHub

NOW = datetime.datetime(2026, 10, 17, 12, 0, tzinfo=datetime.UTC)


class Clock:
    """A clock the tests move by hand."""

    def __init__(self) -> None:
        self.now = NOW

    def __call__(self) -> datetime.datetime:
        return self.now


@pytest.fixture
def github() -> FakeGitHub:
    return FakeGitHub()


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture
def data_dir(tmp_path: pathlib.Path) -> pathlib.Path:
    return tmp_path / "data-branch"


@pytest.fixture
def cache_dir(tmp_path: pathlib.Path) -> pathlib.Path:
    return tmp_path / "cache"


@pytest.fixture
def make_scanner(github: FakeGitHub, clock: Clock, data_dir: pathlib.Path, cache_dir: pathlib.Path):
    """Build a scanner as a fresh scan would: reading the cache and the data branch from disk."""

    def make(*, backfill_days: float = 90, force: bool = False) -> tuple[Scanner, GitHubClient]:
        cache = Cache(cache_dir)
        client = GitHubClient(token="token", cache=cache, transport=github, sleep=lambda _: None, now=clock)
        scanner = Scanner(
            client=client,
            cache=cache,
            store=DataStore(data_dir),
            backfill=datetime.timedelta(days=backfill_days),
            force=force,
            now=clock,
        )
        return scanner, client

    return make


def config(*, organizations=(), repositories=(), include_forks=False) -> Config:
    return Config(organizations=tuple(organizations), repositories=tuple(repositories), include_forks=include_forks)
