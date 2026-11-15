import type { PipelineStage } from "mongoose";
import { Case, type ICase } from "@/models/Case";
import { Court } from "@/models/Court";
import { buildCaseSort, type CaseSort } from "@/lib/case-sort";

// Fetches a page of cases in the requested order. Every sort is a plain
// `find().sort()` except "hearing", which reads the way a cause list is
// read: by hearing day, then by court in Court Hub order, then by case
// number.
//
//   • The day is the calendar day in India, so two matters on the same
//     date compare by court even when one was saved with a time of day.
//   • A court's place is the first number in its Court Hub `number`
//     ("Hall 3" → 3) — the same rule as Court Hub's firstNumber() and the
//     mobile app's lib/court-order. Numbered courts come first, then the
//     un-numbered ones by name.
//   • The live Court Hub court wins. A case whose court was deleted, or
//     was typed in by hand, falls back to the number and name copied onto
//     it when it was filed.
//
// It runs in the database rather than in JS because the Case Vault is
// paginated: sorting each page on its own would order the page, not the
// list. Undated matters still lead, as they always have.

const FIRST_NUMBER = "-?\\d+(?:\\.\\d+)?";

const HELPER_FIELDS = [
  "_court",
  "_liveCourt",
  "_day",
  "_numMatch",
  "_courtNo",
  "_hasCourtNo",
  "_courtName",
];

function hearingOrderStages(filter: Record<string, unknown>): PipelineStage[] {
  return [
    { $match: filter },
    {
      $lookup: {
        from: Court.collection.name,
        localField: "courtId",
        foreignField: "_id",
        pipeline: [{ $project: { name: 1, number: 1, isDeleted: 1 } }],
        as: "_court",
      },
    },
    { $set: { _court: { $first: "$_court" } } },
    {
      $set: {
        _liveCourt: {
          $cond: [{ $eq: ["$_court.isDeleted", false] }, "$_court", null],
        },
      },
    },
    {
      $set: {
        _day: {
          $dateToString: {
            format: "%Y-%m-%d",
            date: "$nextHearingDate",
            timezone: "Asia/Kolkata",
          },
        },
        _numMatch: {
          $regexFind: {
            input: { $ifNull: ["$_liveCourt.number", "$courtNumber"] },
            regex: FIRST_NUMBER,
          },
        },
        _courtName: {
          $toLower: { $ifNull: ["$_liveCourt.name", "$courtName"] },
        },
      },
    },
    { $set: { _courtNo: { $toDouble: "$_numMatch.match" } } },
    {
      $set: {
        _hasCourtNo: {
          $cond: [{ $eq: [{ $type: "$_courtNo" }, "double"] }, 1, 0],
        },
      },
    },
    {
      $sort: {
        _day: 1,
        _hasCourtNo: -1,
        _courtNo: 1,
        _courtName: 1,
        caseNo: 1,
        _id: 1,
      },
    },
  ];
}

export async function findCasesInOrder(
  filter: Record<string, unknown>,
  sort: CaseSort,
  page: { skip?: number; limit: number }
): Promise<ICase[]> {
  const skip = page.skip ?? 0;
  if (sort !== "hearing") {
    return Case.find(filter)
      .sort(buildCaseSort(sort))
      .skip(skip)
      .limit(page.limit)
      .lean<ICase[]>();
  }
  const stages = hearingOrderStages(filter);
  if (skip > 0) stages.push({ $skip: skip });
  stages.push({ $limit: page.limit }, { $unset: HELPER_FIELDS });
  return Case.aggregate<ICase>(stages).allowDiskUse(true);
}
