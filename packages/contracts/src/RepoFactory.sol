// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {RefRegistry} from "./RefRegistry.sol";

contract RepoFactory {
    error InvalidOwner();
    error InvalidLabel();

    uint256 public nonce;
    mapping(bytes32 repoId => address refRegistry) public repositories;

    event RepoCreated(
        bytes32 indexed repoId,
        bytes32 indexed orgId,
        bytes32 indexed labelhash,
        address owner,
        address refRegistry,
        bytes32 policyHash
    );

    function createRepo(bytes32 orgId, string calldata label, address owner, bytes32 policyHash)
        external
        returns (bytes32 repoId, address refRegistry)
    {
        if (owner == address(0)) revert InvalidOwner();
        bytes memory labelBytes = bytes(label);
        if (labelBytes.length == 0 || labelBytes.length > 63) revert InvalidLabel();
        bytes32 labelhash = keccak256(labelBytes);
        repoId = keccak256(abi.encode(block.chainid, address(this), nonce++, orgId, labelhash));
        RefRegistry registry = new RefRegistry(owner);
        refRegistry = address(registry);
        repositories[repoId] = refRegistry;
        emit RepoCreated(repoId, orgId, labelhash, owner, refRegistry, policyHash);
    }
}
