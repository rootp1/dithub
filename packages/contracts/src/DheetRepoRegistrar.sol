// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

interface IPermissionedRegistry {
    function register(
        string calldata label,
        address owner,
        address subregistry,
        address resolver,
        uint256 roleBitmap,
        uint64 expiry
    ) external returns (uint256 tokenId);

    function renew(uint256 anyId, uint64 expiry) external returns (uint64 newExpiry);
}

contract DheetRepoRegistrar {
    error Unauthorized();
    error InvalidOwner();
    error InvalidExpiry();

    IPermissionedRegistry public immutable registry;
    address public immutable controller;

    event RepoNameRegistered(
        uint256 indexed tokenId,
        string label,
        address indexed owner,
        address resolver,
        address subregistry,
        uint64 expiry
    );
    event RepoNameRenewed(uint256 indexed labelhash, uint64 newExpiry);

    constructor(IPermissionedRegistry registry_, address controller_) {
        registry = registry_;
        controller = controller_;
    }

    function register(
        string calldata label,
        address owner,
        address subregistry,
        address resolver,
        uint256 roleBitmap,
        uint64 expiry
    ) external returns (uint256 tokenId) {
        if (msg.sender != controller) revert Unauthorized();
        if (owner == address(0)) revert InvalidOwner();
        if (expiry <= block.timestamp) revert InvalidExpiry();
        tokenId = registry.register(label, owner, subregistry, resolver, roleBitmap, expiry);
        emit RepoNameRegistered(tokenId, label, owner, resolver, subregistry, expiry);
    }

    function renew(string calldata label, uint64 expiry) external returns (uint64 newExpiry) {
        if (expiry <= block.timestamp) revert InvalidExpiry();
        uint256 labelhash = uint256(keccak256(bytes(label)));
        newExpiry = registry.renew(labelhash, expiry);
        emit RepoNameRenewed(labelhash, newExpiry);
    }
}
