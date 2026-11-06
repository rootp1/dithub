// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title DeployRegistry
/// @notice Append-only registry of published releases (git commit + bundle hash + url).
contract DeployRegistry {
    struct Release {
        bytes32 commit;
        bytes32 bundleHash;
        string url;
        uint64 publishedAt;
        address publisher;
    }

    error NotOwner();
    error NotPublisher();
    error ZeroAddress();
    error UnknownRelease();
    error NoReleases();

    event ReleasePublished(
        uint256 indexed id,
        bytes32 indexed commit,
        bytes32 bundleHash,
        string url,
        address indexed publisher
    );
    event PublisherSet(address indexed publisher, bool allowed);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    address public owner;
    mapping(address => bool) public isPublisher;
    uint256 public releaseCount;
    mapping(uint256 => Release) private _releases;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address owner_) {
        if (owner_ == address(0)) revert ZeroAddress();
        owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
    }

    function setPublisher(address publisher, bool allowed) external onlyOwner {
        isPublisher[publisher] = allowed;
        emit PublisherSet(publisher, allowed);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function publish(bytes32 commit, bytes32 bundleHash, string calldata url)
        external
        returns (uint256 id)
    {
        if (!isPublisher[msg.sender]) revert NotPublisher();
        id = ++releaseCount;
        _releases[id] = Release(commit, bundleHash, url, uint64(block.timestamp), msg.sender);
        emit ReleasePublished(id, commit, bundleHash, url, msg.sender);
    }

    function getRelease(uint256 id)
        public
        view
        returns (
            bytes32 commit,
            bytes32 bundleHash,
            string memory url,
            uint64 publishedAt,
            address publisher
        )
    {
        if (id == 0 || id > releaseCount) revert UnknownRelease();
        Release storage r = _releases[id];
        return (r.commit, r.bundleHash, r.url, r.publishedAt, r.publisher);
    }

    /// @notice Returns id 0 (and zeroed fields) when nothing has been published.
    function latestRelease()
        external
        view
        returns (
            uint256 id,
            bytes32 commit,
            bytes32 bundleHash,
            string memory url,
            uint64 publishedAt,
            address publisher
        )
    {
        id = releaseCount;
        if (id == 0) return (0, bytes32(0), bytes32(0), "", 0, address(0));
        (commit, bundleHash, url, publishedAt, publisher) = getRelease(id);
    }
}
