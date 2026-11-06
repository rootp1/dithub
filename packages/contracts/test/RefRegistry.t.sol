// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {RefRegistry} from "../src/RefRegistry.sol";
import {RepoFactory} from "../src/RepoFactory.sol";

contract Writer {
    function update(
        RefRegistry registry,
        bytes32 refKey,
        bytes32 expectedOld,
        bytes32 newOid,
        bytes32 manifestRoot,
        uint64 expectedSequence,
        uint32 flags
    ) external returns (uint64, bytes32) {
        return registry.updateRef(
            refKey, expectedOld, newOid, manifestRoot, expectedSequence, flags
        );
    }
}

contract ContractSigner {
    bytes4 private constant MAGIC = 0x1626ba7e;
    bytes32 public allowedDigest;

    function setAllowedDigest(bytes32 digest) external {
        allowedDigest = digest;
    }

    function isValidSignature(bytes32 digest, bytes calldata signature)
        external
        view
        returns (bytes4)
    {
        if (digest == allowedDigest && keccak256(signature) == keccak256("approved")) {
            return MAGIC;
        }
        return 0xffffffff;
    }
}

contract MockEnsRegistry {
    mapping(address => uint256) public rootRoles;

    function grantRootRoles(uint256 roleBitmap, address account) external {
        rootRoles[account] |= roleBitmap;
    }

    function revokeRootRoles(uint256 roleBitmap, address account) external {
        rootRoles[account] &= ~roleBitmap;
    }

    function hasRoles(uint256, uint256 roleBitmap, address account) external view returns (bool) {
        return (rootRoles[account] & roleBitmap) == roleBitmap;
    }
}

contract RefRegistryTest {
    function testEnsSeatHoldersCanWriteAndOthersCannot() public {
        RefRegistry registry = new RefRegistry(address(this));
        MockEnsRegistry ens = new MockEnsRegistry();
        Writer seated = new Writer();
        Writer stranger = new Writer();
        registry.setEnsGate(address(ens));
        ens.grantRootRoles(registry.ENS_WRITER_ROLE(), address(seated));
        bytes32 refKey = keccak256("refs/heads/main");
        require(!registry.isWriter(address(stranger)), "stranger seated");
        try stranger.update(registry, refKey, bytes32(0), keccak256("a"), keccak256("m"), 0, 0) {
            revert("stranger wrote");
        } catch {}
        seated.update(registry, refKey, bytes32(0), keccak256("a"), keccak256("m"), 0, 0);
        ens.revokeRootRoles(registry.ENS_WRITER_ROLE(), address(seated));
        try seated.update(registry, refKey, keccak256("a"), keccak256("b"), keccak256("m2"), 1, 0) {
            revert("revoked seat wrote");
        } catch {}
    }

    function testOwnerCanCreateAndAdvanceRef() public {
        RefRegistry registry = new RefRegistry(address(this));
        bytes32 refKey = keccak256("refs/heads/main");
        bytes32 first = keccak256("first");
        bytes32 second = keccak256("second");
        (uint64 sequence,) = registry.updateRef(refKey, bytes32(0), first, keccak256("m1"), 0, 0);
        require(sequence == 1, "first sequence");
        (sequence,) = registry.updateRef(refKey, first, second, keccak256("m2"), 1, 0);
        require(sequence == 2, "second sequence");
        RefRegistry.RefState memory current = registry.state(refKey);
        require(current.oid == second, "head mismatch");
    }

    function testStaleCompareAndSwapFails() public {
        RefRegistry registry = new RefRegistry(address(this));
        bytes32 refKey = keccak256("refs/heads/main");
        registry.updateRef(refKey, bytes32(0), keccak256("first"), keccak256("m1"), 0, 0);
        (bool success,) = address(registry)
            .call(
                abi.encodeCall(
                    registry.updateRef,
                    (refKey, bytes32(0), keccak256("stale"), keccak256("m2"), 0, 0)
                )
            );
        require(!success, "stale CAS succeeded");
    }

    function testWriterRoleAndForcePushRoleAreSeparate() public {
        RefRegistry registry = new RefRegistry(address(this));
        Writer writer = new Writer();
        registry.setRole(registry.WRITER_ROLE(), address(writer), true);
        bytes32 refKey = keccak256("refs/heads/main");
        writer.update(registry, refKey, bytes32(0), keccak256("first"), keccak256("m1"), 0, 0);
        (bool success,) = address(writer)
            .call(
                abi.encodeCall(
                    writer.update,
                    (
                        registry,
                        refKey,
                        keccak256("first"),
                        keccak256("rewrite"),
                        keccak256("m2"),
                        1,
                        registry.FLAG_FORCE()
                    )
                )
            );
        require(!success, "writer forced without force role");
        registry.setRole(registry.FORCE_PUSH_ROLE(), address(writer), true);
        writer.update(
            registry,
            refKey,
            keccak256("first"),
            keccak256("rewrite"),
            keccak256("m2"),
            1,
            registry.FLAG_FORCE()
        );
    }

    function testFactoryCreatesIsolatedRegistry() public {
        RepoFactory factory = new RepoFactory();
        (bytes32 repoId, address registryAddress) =
            factory.createRepo(keccak256("org"), "repo", address(this), keccak256("policy"));
        require(repoId != bytes32(0), "empty repo id");
        require(factory.repositories(repoId) == registryAddress, "registry missing");
        require(RefRegistry(registryAddress).owner() == address(this), "wrong owner");
    }

    function testContractWalletSignatureAndNonce() public {
        RefRegistry registry = new RefRegistry(address(this));
        ContractSigner signer = new ContractSigner();
        registry.setRole(registry.WRITER_ROLE(), address(signer), true);
        RefRegistry.RefUpdateRequest memory request = RefRegistry.RefUpdateRequest({
            refKey: keccak256("refs/heads/main"),
            expectedOld: bytes32(0),
            newOid: keccak256("signed"),
            manifestRoot: keccak256("manifest"),
            expectedSequence: 0,
            flags: 0,
            nonce: 0,
            deadline: uint64(block.timestamp + 1 days)
        });
        signer.setAllowedDigest(registry.hashRefUpdate(request));
        registry.updateRefBySig(request, address(signer), "approved");
        require(registry.nonces(address(signer)) == 1, "nonce not consumed");
        (bool success,) = address(registry)
            .call(
                abi.encodeCall(
                    registry.updateRefBySig, (request, address(signer), bytes("approved"))
                )
            );
        require(!success, "signature replayed");
    }

    function testFuzzCompareAndSwapPreservesOrdering(bytes32 first, bytes32 second) public {
        if (first == bytes32(0)) first = bytes32(uint256(1));
        if (second == bytes32(0)) second = bytes32(uint256(2));
        RefRegistry registry = new RefRegistry(address(this));
        bytes32 refKey = keccak256("refs/heads/fuzz");
        (uint64 firstSequence,) =
            registry.updateRef(refKey, bytes32(0), first, keccak256("manifest-1"), 0, 0);
        (uint64 secondSequence,) =
            registry.updateRef(refKey, first, second, keccak256("manifest-2"), firstSequence, 0);
        require(firstSequence == 1 && secondSequence == 2, "sequence invariant");
        require(registry.globalSequence() == 2, "global sequence invariant");
        require(registry.state(refKey).oid == second, "latest value invariant");
    }

    function testDeleteRequiresDeleteFlagAndZeroOid() public {
        RefRegistry registry = new RefRegistry(address(this));
        bytes32 refKey = keccak256("refs/heads/delete");
        bytes32 first = keccak256("first");
        registry.updateRef(refKey, bytes32(0), first, keccak256("manifest"), 0, 0);
        (bool invalidDelete,) = address(registry)
            .call(abi.encodeCall(registry.updateRef, (refKey, first, bytes32(0), bytes32(0), 1, 0)));
        require(!invalidDelete, "zero oid accepted without delete flag");
        registry.updateRef(refKey, first, bytes32(0), bytes32(0), 1, registry.FLAG_DELETE());
    }
}
