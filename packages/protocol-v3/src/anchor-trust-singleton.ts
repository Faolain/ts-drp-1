import { createAnchorTrustApi } from "./index.js";
import {
	certifiedSealAuthorityResolver,
	creatorAnchorTrustResolver,
	creatorAnchorTrustSuccessorMinter,
	installCertifiedSealAuthorityResolver,
	installCreatorAnchorTrustCustody,
} from "./internal/seal-authority-custody.js";

const anchorTrustApi = createAnchorTrustApi();
installCertifiedSealAuthorityResolver(anchorTrustApi[certifiedSealAuthorityResolver]);
installCreatorAnchorTrustCustody(
	anchorTrustApi[creatorAnchorTrustResolver],
	anchorTrustApi[creatorAnchorTrustSuccessorMinter]
);

export const {
	authenticateCurrentEpochAnchor,
	installCertifiedAnchorTrustRoot,
	installCreatorAnchorTrustRoot,
	isAnchorTrustStateRecordBytes,
	openCertifiedAnchorTrust,
	openCurrentAnchorTrust,
	openCurrentEpochAuthorAuthorization,
	resolveCurrentEpochAuthorizedAuthor,
} = anchorTrustApi;
