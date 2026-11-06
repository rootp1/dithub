// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @dev Minimal ENSv2 Enhanced Access Control read interface (UserRegistry / PermissionedRegistry).
interface IEnsAccessControl {
    function hasRoles(uint256 resource, uint256 roleBitmap, address account) external view returns (bool);
}

contract RefRegistry {
    error Unauthorized();
    error InvalidOwner();
    error InvalidRefName();
    error InvalidRefValue();
    error InvalidFlags();
    error RefConflict(bytes32 currentOid, uint64 currentSequence);
    error SignatureExpired();
    error InvalidNonce(uint256 expected, uint256 actual);
    error InvalidSignature();

    bytes32 public constant OWNER_ROLE = keccak256("OWNER_ROLE");
    bytes32 public constant WRITER_ROLE = keccak256("WRITER_ROLE");
    bytes32 public constant FORCE_PUSH_ROLE = keccak256("FORCE_PUSH_ROLE");

    /// @notice ENSv2 ROLE_REGISTRAR (1 << 0). Holding it on the org registry's ROOT_RESOURCE is a Dheet writer seat.
    uint256 public constant ENS_WRITER_ROLE = 1 << 0;
    uint256 public constant ENS_ROOT_RESOURCE = 0;

    uint32 public constant FLAG_FORCE = 1;
    uint32 public constant FLAG_DELETE = 2;
    bytes4 private constant EIP1271_MAGIC_VALUE = 0x1626ba7e;
    uint256 private constant SECP256K1_HALF_ORDER =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;
    bytes32 private constant UPDATE_TYPEHASH = keccak256(
        "RefUpdate(bytes32 refKey,bytes32 expectedOld,bytes32 newOid,bytes32 manifestRoot,uint64 expectedSequence,uint32 flags,uint256 nonce,uint64 deadline)"
    );
    bytes32 private immutable initialDomainSeparator;
    uint256 private immutable initialChainId;

    struct RefState {
        bytes32 oid;
        bytes32 manifestRoot;
        uint64 sequence;
        uint32 flags;
    }

    struct RefUpdateRequest {
        bytes32 refKey;
        bytes32 expectedOld;
        bytes32 newOid;
        bytes32 manifestRoot;
        uint64 expectedSequence;
        uint32 flags;
        uint256 nonce;
        uint64 deadline;
    }

    address public owner;
    /// @notice Optional ENSv2 org registry whose EAC roles grant writer seats. Zero disables the gate.
    IEnsAccessControl public ensGate;
    uint64 public globalSequence;
    bytes32 public refRoot;

    mapping(bytes32 role => mapping(address account => bool enabled)) public hasRole;
    mapping(bytes32 refKey => RefState state) private refs;
    mapping(address signer => uint256 nonce) public nonces;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event EnsGateUpdated(address indexed gate);
    event RoleUpdated(bytes32 indexed role, address indexed account, bool enabled);
    event RefUpdated(
        bytes32 indexed refKey,
        bytes32 indexed oldOid,
        bytes32 indexed newOid,
        bytes32 manifestRoot,
        uint64 sequence,
        uint32 flags,
        address writer,
        bytes32 refRoot
    );

    constructor(address initialOwner) {
        if (initialOwner == address(0)) revert InvalidOwner();
        owner = initialOwner;
        hasRole[OWNER_ROLE][initialOwner] = true;
        hasRole[WRITER_ROLE][initialOwner] = true;
        hasRole[FORCE_PUSH_ROLE][initialOwner] = true;
        initialChainId = block.chainid;
        initialDomainSeparator = _computeDomainSeparator();
        emit OwnershipTransferred(address(0), initialOwner);
    }

    modifier onlyOwner() {
        if (!hasRole[OWNER_ROLE][msg.sender]) revert Unauthorized();
        _;
    }

    function setRole(bytes32 role, address account, bool enabled) external onlyOwner {
        if (account == address(0)) revert InvalidOwner();
        hasRole[role][account] = enabled;
        emit RoleUpdated(role, account, enabled);
    }

    function setEnsGate(address gate) external onlyOwner {
        ensGate = IEnsAccessControl(gate);
        emit EnsGateUpdated(gate);
    }

    function isWriter(address account) public view returns (bool) {
        if (hasRole[WRITER_ROLE][account]) return true;
        if (address(ensGate) == address(0)) return false;
        try ensGate.hasRoles(ENS_ROOT_RESOURCE, ENS_WRITER_ROLE, account) returns (bool seated) {
            return seated;
        } catch {
            return false;
        }
    }

    function transferOwnership(address nextOwner) external onlyOwner {
        if (nextOwner == address(0)) revert InvalidOwner();
        address previousOwner = owner;
        owner = nextOwner;
        hasRole[OWNER_ROLE][previousOwner] = false;
        hasRole[OWNER_ROLE][nextOwner] = true;
        hasRole[WRITER_ROLE][nextOwner] = true;
        emit OwnershipTransferred(previousOwner, nextOwner);
    }

    function state(bytes32 refKey) external view returns (RefState memory) {
        return refs[refKey];
    }

    function domainSeparator() public view returns (bytes32) {
        return block.chainid == initialChainId ? initialDomainSeparator : _computeDomainSeparator();
    }

    function hashRefUpdate(RefUpdateRequest calldata request) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                UPDATE_TYPEHASH,
                request.refKey,
                request.expectedOld,
                request.newOid,
                request.manifestRoot,
                request.expectedSequence,
                request.flags,
                request.nonce,
                request.deadline
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function updateRef(
        bytes32 refKey,
        bytes32 expectedOld,
        bytes32 newOid,
        bytes32 manifestRoot,
        uint64 expectedSequence,
        uint32 flags
    ) external returns (uint64 newSequence, bytes32 newRefRoot) {
        return _updateRef(
            refKey, expectedOld, newOid, manifestRoot, expectedSequence, flags, msg.sender
        );
    }

    function updateRefBySig(
        RefUpdateRequest calldata request,
        address signer,
        bytes calldata signature
    ) external returns (uint64 newSequence, bytes32 newRefRoot) {
        if (block.timestamp > request.deadline) revert SignatureExpired();
        uint256 expectedNonce = nonces[signer];
        if (request.nonce != expectedNonce) revert InvalidNonce(expectedNonce, request.nonce);
        if (!_isValidSignature(signer, hashRefUpdate(request), signature)) {
            revert InvalidSignature();
        }
        nonces[signer] = expectedNonce + 1;
        return _updateRef(
            request.refKey,
            request.expectedOld,
            request.newOid,
            request.manifestRoot,
            request.expectedSequence,
            request.flags,
            signer
        );
    }

    function _updateRef(
        bytes32 refKey,
        bytes32 expectedOld,
        bytes32 newOid,
        bytes32 manifestRoot,
        uint64 expectedSequence,
        uint32 flags,
        address writer
    ) private returns (uint64 newSequence, bytes32 newRefRoot) {
        if (refKey == bytes32(0)) revert InvalidRefName();
        if ((flags & ~(FLAG_FORCE | FLAG_DELETE)) != 0) revert InvalidFlags();
        if (((flags & FLAG_DELETE) != 0) != (newOid == bytes32(0))) revert InvalidRefValue();
        if (!isWriter(writer)) revert Unauthorized();
        if ((flags & FLAG_FORCE) != 0 && !hasRole[FORCE_PUSH_ROLE][writer]) {
            revert Unauthorized();
        }

        RefState storage current = refs[refKey];
        if (current.oid != expectedOld || current.sequence != expectedSequence) {
            revert RefConflict(current.oid, current.sequence);
        }

        newSequence = ++globalSequence;
        bytes32 oldOid = current.oid;
        current.oid = newOid;
        current.manifestRoot = manifestRoot;
        current.sequence = newSequence;
        current.flags = flags;
        newRefRoot = keccak256(
            abi.encode(refRoot, refKey, oldOid, newOid, manifestRoot, newSequence, flags)
        );
        refRoot = newRefRoot;
        emit RefUpdated(
            refKey, oldOid, newOid, manifestRoot, newSequence, flags, writer, newRefRoot
        );
    }

    function _computeDomainSeparator() private view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256("DheetRefRegistry"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }

    function _isValidSignature(address signer, bytes32 digest, bytes calldata signature)
        private
        view
        returns (bool)
    {
        if (signer.code.length != 0) {
            (bool success, bytes memory result) = signer.staticcall(
                abi.encodeWithSignature("isValidSignature(bytes32,bytes)", digest, signature)
            );
            return success && result.length >= 32 && bytes4(result) == EIP1271_MAGIC_VALUE;
        }
        if (signature.length != 65) return false;
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (uint256(s) > SECP256K1_HALF_ORDER || (v != 27 && v != 28)) return false;
        return ecrecover(digest, v, r, s) == signer;
    }
}
