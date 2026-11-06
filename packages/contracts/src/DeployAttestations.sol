// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

/// @notice Chainlink CRE receiver interface (mirrors Chainlink's IReceiver).
interface IReceiver is IERC165 {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

interface IDeployRegistry {
    function releaseCount() external view returns (uint256);
    function getRelease(uint256 id)
        external
        view
        returns (
            bytes32 commit,
            bytes32 bundleHash,
            string memory url,
            uint64 publishedAt,
            address publisher
        );
}

/// @title DeployAttestations
/// @notice CRE consumer: stores workflow-signed liveness/integrity attestations per release.
/// @dev report = abi.encode(uint256 releaseId, bytes32 commit, bytes32 bundleHash, bool ok, uint64 observedAt)
contract DeployAttestations is IReceiver {
    struct Attestation {
        bool exists;
        bool ok;
        uint64 observedAt;
        uint256 count;
        bytes32 lastMetadataHash;
    }

    error NotOwner();
    error ZeroAddress();
    error InvalidSender(address sender, address expected);
    error UnknownRelease(uint256 releaseId);
    error ReleaseMismatch(uint256 releaseId);

    event Attested(uint256 indexed releaseId, bytes32 indexed bundleHash, bool ok, uint64 observedAt);
    event ForwarderUpdated(address indexed previousForwarder, address indexed newForwarder);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    address public owner;
    address public forwarder;
    IDeployRegistry public immutable registry;

    mapping(uint256 => Attestation) private _attestations;
    uint256 private _latestReleaseId;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address owner_, address forwarder_, address registry_) {
        if (owner_ == address(0) || forwarder_ == address(0) || registry_ == address(0)) {
            revert ZeroAddress();
        }
        owner = owner_;
        forwarder = forwarder_;
        registry = IDeployRegistry(registry_);
        emit OwnershipTransferred(address(0), owner_);
        emit ForwarderUpdated(address(0), forwarder_);
    }

    function setForwarder(address newForwarder) external onlyOwner {
        if (newForwarder == address(0)) revert ZeroAddress();
        emit ForwarderUpdated(forwarder, newForwarder);
        forwarder = newForwarder;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function onReport(bytes calldata metadata, bytes calldata report) external override {
        if (msg.sender != forwarder) revert InvalidSender(msg.sender, forwarder);

        (uint256 releaseId, bytes32 commit, bytes32 bundleHash, bool ok, uint64 observedAt) =
            abi.decode(report, (uint256, bytes32, bytes32, bool, uint64));

        if (releaseId == 0 || releaseId > registry.releaseCount()) {
            revert UnknownRelease(releaseId);
        }
        (bytes32 rCommit, bytes32 rBundle,,,) = registry.getRelease(releaseId);
        if (rCommit != commit || rBundle != bundleHash) revert ReleaseMismatch(releaseId);

        Attestation storage a = _attestations[releaseId];
        a.exists = true;
        a.ok = ok;
        a.observedAt = observedAt;
        a.count += 1;
        a.lastMetadataHash = keccak256(metadata);
        if (releaseId >= _latestReleaseId) _latestReleaseId = releaseId;

        emit Attested(releaseId, bundleHash, ok, observedAt);
    }

    function attestation(uint256 releaseId)
        external
        view
        returns (bool exists, bool ok, uint64 observedAt, uint256 count)
    {
        Attestation storage a = _attestations[releaseId];
        return (a.exists, a.ok, a.observedAt, a.count);
    }

    function lastMetadataHash(uint256 releaseId) external view returns (bytes32) {
        return _attestations[releaseId].lastMetadataHash;
    }

    /// @notice Attestation for the highest release id that has been attested (0 if none).
    function latestAttestation()
        external
        view
        returns (uint256 releaseId, bool ok, uint64 observedAt)
    {
        releaseId = _latestReleaseId;
        Attestation storage a = _attestations[releaseId];
        return (releaseId, a.ok, a.observedAt);
    }

    function supportsInterface(bytes4 interfaceId) public pure override returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }
}
