/*
 * Mesh distortion ratios, as a committed fixture. Generated, do not hand-edit.
 *
 * SF3D guesses depth from one photo, so a wide-shallow piece binds to its measured box with
 * visible stretch. The binder reports that as `distortion_ratio` (services/gen/app/binding:
 * max(t/e)/min(t/e)); 1.5 and above is the "dimensional proxy recommended" band. The numbers
 * below are copied from P-PAUL's bind of the catalogue meshes
 * (integration-sweep/reports/p-paul-distortion.json, 85 rows, 2026-09-20). Nothing reads the
 * work-wiki at runtime.
 *
 * ceiling: a committed copy goes stale the moment another mesh is bound, and a row bound after
 * this file was written has no entry at all. The ratio belongs on the D1 `objects` row or in a
 * stored receipt, written at attach time by component C (POST /v1/objects/{id}/mesh); this
 * file is what makes the ordering possible without a migration during the sprint.
 */

/** The band at which the binder stops recommending the mesh over a dimensional proxy. */
export const DISTORTION_LIMIT = 1.5;

export const DISTORTION_RATIOS: Record<string, number> = {
  "2e025e99-bcb5-522f-a84f-56ee2e473d7c": 1.0309,
  "5477a3c8-90da-51a9-ad4d-cf328d9cd07b": 1.0411,
  "ce9ac845-8e27-5d41-a43b-87f3475f80ed": 1.072,
  "659a704f-a1d0-5a94-a19e-8705d06dc180": 1.0781,
  "f9aec4d6-78b8-59ea-a896-f776a4725182": 1.0991,
  "18dd2a7f-16aa-59c4-aa91-382c6b1873ab": 1.105,
  "1ae6d53a-958b-5e19-a380-b6675d9a84fc": 1.126,
  "0d275307-1e4c-573f-a859-d5a868ee4676": 1.1306,
  "09d1b932-526e-575d-a39b-bc92b79aa46b": 1.1345,
  "443d1a6c-2e26-5af8-a42f-b55fed9cc38d": 1.1486,
  "3afa502a-816b-518b-ae2d-08f177fd6b11": 1.1588,
  "32fc9a5e-0555-5b5f-a218-5da09cf9e4aa": 1.1601,
  "b9b14be5-c749-5df4-a9f9-58665cf15d80": 1.1738,
  "ab771c42-6716-5a86-a1ec-2023c944d193": 1.192,
  "08300e9d-edc2-5593-a8d0-bf51ffb61e75": 1.1996,
  "f1a3f4cd-7324-556a-a5bb-5afd11fe79ad": 1.2183,
  "c31b56fc-e58d-5a41-a1f5-5c2149ec37fa": 1.2256,
  "91bbdaf3-4d08-5d8d-ad56-baac71e73ccb": 1.2343,
  "fd0929b9-b090-5deb-acae-fb1d7d5686ac": 1.2378,
  "7dde239e-dd4f-5d48-a284-7bc563abc17e": 1.2619,
  "cedadc23-a84e-5c5e-adee-bf66a30cda2a": 1.2673,
  "25c49de4-9bba-590a-a5b9-c9f55a89ee34": 1.2867,
  "27b87e47-a372-572b-af32-0145c944d46b": 1.3167,
  "a003a2b8-d4f8-573e-ac51-d50496f0e47c": 1.318,
  "1c010b12-bdc9-59d6-a009-d8fb8ba81ada": 1.3598,
  "fbf2577b-f8cd-5b33-a18e-1294b1767a05": 1.3656,
  "29c35074-e5ae-58d5-a5cf-8e932f41de72": 1.3823,
  "d44b0d09-9052-5015-adb3-05d9528f3989": 1.3881,
  "3be99581-3a66-5b7a-a338-132226f48aae": 1.4011,
  "a777ffae-5474-516d-a724-b4e04e56e48c": 1.42,
  "4956f9ea-953a-55e6-ad3d-810e87e65651": 1.426,
  "ce744d65-f073-5172-ae87-2f6ba94b0f93": 1.4314,
  "da78d6bc-438f-519b-acb4-7cee6e52b590": 1.4479,
  "6aaf3bb1-26e8-54c0-a166-50d7fee7d754": 1.4592,
  "818aecde-0d60-5c0b-a503-ed138ee76849": 1.4593,
  "37b4bef2-4c8b-5260-ab52-35e441c0bb7d": 1.4674,
  "b4d0b829-fb14-528d-afec-b5a480a3c5a4": 1.4773,
  "e22b8e5b-334b-507b-ac3b-3426ca5f6a10": 1.4798,
  "0d7e7fc5-6c72-54c4-aafc-63c14cf565d4": 1.4814,
  "5669fe72-281c-577f-a050-b6cfaaaf545c": 1.5085,
  "7edf7739-248d-56ef-a569-a6bef286e1c6": 1.5364,
  "b9250041-94e3-546b-a774-c00454443a06": 1.5425,
  "05bfb4f7-b01d-5c1e-a7cd-877b71f0210f": 1.5486,
  "61006f84-b7c6-5e26-a196-204b838765c7": 1.5591,
  "a15548b9-ec31-54c5-a32a-75c46add082b": 1.5714,
  "28b0e31a-1c03-50ae-a5b8-b6975bcd4dcf": 1.5994,
  "72828efd-0a46-5d12-a1d6-59a3018d6989": 1.6073,
  "10958eed-8123-5569-acf7-413f2018e47a": 1.6078,
  "504dbde7-911b-52d9-a5ad-0e82eaada783": 1.6124,
  "4b44c2d7-a797-57d6-aec8-9b0371f7f4bf": 1.6151,
  "e40f7df9-c5d8-5e9c-a391-010b0015b7a0": 1.6344,
  "e0a62182-382d-55df-a6e1-474a88f8bfb2": 1.6466,
  "980dffd9-09ff-56b1-a125-3ae9f2ab108d": 1.6483,
  "0ffccdc9-4f39-50a3-af6e-5acd1d7994fb": 1.6731,
  "7efcf47f-342d-5538-a5c7-08aaf6c8d502": 1.7012,
  "5c898f05-18fb-5d92-a187-7ad1ee054bf7": 1.9215,
  "139e7b4a-9e4b-57b8-a5f1-0e9b00d29f00": 1.9295,
  "2edb034f-593a-5f37-ae6e-e4ded0c412f2": 1.9547,
  "18df0832-38d7-5ac2-ad5a-ecb8bad0b732": 2.0026,
  "94a9b860-2764-590b-ad13-f623d915e380": 2.007,
  "5dedb9f8-ca1f-56f4-ade8-d8fa458b8cf2": 2.0094,
  "f2b4c417-aff2-5a6b-ad42-d07ef531b2fd": 2.0903,
  "a9f6b02c-3aa4-5dd6-ad16-868920122131": 2.2356,
  "3ca7d239-1385-52a1-a214-3c9aed8364c3": 2.2507,
  "0bb7b880-f74f-5668-a2d0-b47f99948e2c": 2.256,
  "39a032ad-5a4a-5ddd-a03b-05e5697141f6": 2.2717,
  "33666d2e-9589-5cd8-ad78-9eb2c9256e94": 2.3205,
  "889a0cc9-1151-54a0-a85e-c1968266f095": 2.3971,
  "a2d6d602-938d-5df3-a411-e7b67be60776": 2.6043,
  "f4d5ba22-d1d6-5088-aaa7-b80a53c977e4": 2.7038,
  "45bc9c8b-1deb-5135-af7b-6527b5c5150f": 2.7421,
  "b72d0b70-7463-52b6-a2ef-1cc9c734985a": 2.7515,
  "3317f35b-4f12-52d1-a33d-b3e72b8fb47c": 2.7744,
  "d020c183-e3a7-5481-ae23-b5cc288b0637": 2.7859,
  "e57e1bc5-3c58-5c97-a9b0-b43bd1a82876": 2.8757,
  "1cf6432b-4ac4-5674-ad3f-9c57ea5a9c50": 2.8878,
  "92dbf342-0b12-5c69-a5b5-7fe316d3bf3d": 2.9306,
  "7a3bf14f-007d-519c-aea9-584b16115525": 3.2141,
  "6eb5afd1-b010-50da-a204-cb7f16b550d8": 3.2369,
  "39aa2764-fe02-5aae-abda-a195f1df09a8": 3.4189,
  "2b99202e-7a89-5854-a00d-8a1c1815a550": 4.8852,
  "0d2f6493-78fd-50ed-ad23-b9a2e23bd245": 5.646,
  "fe485e6a-2c5b-5a23-a9be-51709a63224e": 6.7738,
  "343378f6-b4c7-58c9-a614-bf41fd8504a9": 8.7912,
  "02470d80-0da2-5803-a549-cf162000f6f6": 9.3651,
};
